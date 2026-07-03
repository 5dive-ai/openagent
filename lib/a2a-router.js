"use strict";

// OpenAgent A2A router (DIVE-730) — drives the present -> challenge -> respond ->
// verify handshake and the co-signed-receipt exchange over ANY transport
// (lib/a2a-transport.js). Transport-agnostic: it speaks the protocol in opaque
// messages and lets the transport carry them.
//
// Two invariants keep this safe no matter what transport sits underneath — they
// are the same rule the v1 platform enforces server-side ("from_did/to_did are
// derived from the signatures, never from request fields"):
//
//   1. Identity comes from the live handshake, NEVER from the envelope. A peer's
//      did:key is recorded ONLY from a verifyResponse() that proved the peer
//      signed THIS session's fresh nonce. Any `from`/`by` field on an inbound
//      message is a hint at most — never identity. A lying or compromised
//      transport cannot make the router believe a peer is someone else.
//
//   2. Per-session verified-peer state. Each session carries the one did the
//      handshake proved; receipts are built and co-signed against THAT did, so a
//      proposed body that misnames the parties is refused even if its signature
//      is internally valid.
//
// Crypto stays entirely in lib/handshake.js + lib/receipts.js — this file is
// orchestration and state, no new primitives.
//
// Protocol (mutual handshake, then co-sign): both sides prove live key ownership
// before either trusts the other, because a co-signed receipt is an edge BETWEEN
// two identities — each must know the other for real.
//
//   A -> B  hello       { present }                  A presents
//   B -> A  hello_ack   { present, nonce }           B presents + challenges A
//   A -> B  auth        { sig(B.nonce), nonce }      A answers + challenges B
//   B -> A  auth_ack    { sig(A.nonce) }             B answers  (both verified)
//   A -> B  receipt_propose { body, sig }            A attests a closed task
//   B -> A  receipt_cosign  { rid, sig }             B co-signs -> an edge
//
// `error { reason }` aborts a session in either direction.

const crypto = require("crypto");
const hs = require("./handshake");
const rc = require("./receipts");
const { canonicalBytes } = require("./provenance");

const DEFAULT_NONCE_TTL_MS = 30_000;

// Pure helper: is a challenge nonce still inside its single-use freshness window?
// Exported so the verifier-side TTL is unit-testable without real timers.
function nonceFresh(issuedAt, nowMs, ttlMs) {
  return nowMs - issuedAt <= ttlMs;
}

// A receipt's natural id = sha256 of its canonical body. Same key the v1
// platform uses for dedup/replay, and the same one verifyHistory dedups on.
function ridOf(body) {
  return crypto.createHash("sha256").update(canonicalBytes(body)).digest("hex");
}

class A2ARouter {
  constructor({
    identity,
    transport,
    handle = null,
    cardUrl = null,
    nonceTtlMs = DEFAULT_NONCE_TTL_MS,
    now = Date.now,
  } = {}) {
    if (!identity || !identity.privateKey) {
      throw new Error("A2ARouter: identity.privateKey required");
    }
    if (!transport) throw new Error("A2ARouter: transport required");
    this.identity = identity;
    this.selfDid = identity.did || hs.present({ privateKey: identity.privateKey }).did;
    this.transport = transport;
    this.handle = handle;
    this.cardUrl = cardUrl;
    this.nonceTtlMs = nonceTtlMs;
    this.now = now;
    this.sessions = new Map();
    this.ledger = []; // co-signed receipts this router assembled or accepted
    this._listeners = { verified: [], receipt: [], error: [] };
    transport.onMessage((sid, msg) => this._onMessage(sid, msg));
  }

  on(event, cb) {
    if (this._listeners[event]) this._listeners[event].push(cb);
    return this;
  }

  _emit(event, payload) {
    for (const cb of this._listeners[event] || []) cb(payload);
  }

  _presentation() {
    return hs.present({ privateKey: this.identity.privateKey, handle: this.handle, cardUrl: this.cardUrl });
  }

  _session(sid, role) {
    let s = this.sessions.get(sid);
    if (!s) {
      s = {
        id: sid,
        role,
        peerPresentation: null, // UNTRUSTED until the handshake verifies it
        peerDid: null, // TRUSTED: only ever set from a passed verifyResponse()
        verified: false,
        nonceForPeer: null,
        nonceIssuedAt: 0,
        pending: new Map(), // rid -> { body, ourSig, resolve, reject }
        connect: null, // { resolve, reject } for an initiator's connect()
      };
      this.sessions.set(sid, s);
    }
    return s;
  }

  // The handshake-proven peer did for a session, or null if not yet verified.
  verifiedPeer(sid) {
    const s = this.sessions.get(sid);
    return s && s.verified ? s.peerDid : null;
  }

  // ── initiator ────────────────────────────────────────────────────────────
  // Open a session and run the mutual handshake. Resolves once WE have verified
  // the peer's live key ownership, to { sessionId, peerDid }.
  connect(peerRef) {
    const sid = this.transport.open(peerRef);
    const s = this._session(sid, "initiator");
    return new Promise((resolve, reject) => {
      s.connect = { resolve, reject };
      this.transport.send(sid, { t: "hello", present: this._presentation() });
    });
  }

  // After a verified handshake, attest a completed task. The receipt is built
  // with the HANDSHAKE-PROVEN peer did (never a wire value), signed, and sent for
  // co-signature. Resolves to the fully co-signed receipt once the peer signs.
  closeTask(sid, { taskHash, resultHash, at }) {
    const s = this.sessions.get(sid);
    if (!s || !s.verified) {
      return Promise.reject(new Error("closeTask: session not verified"));
    }
    const body = rc.buildReceipt({ taskHash, resultHash, fromDid: this.selfDid, toDid: s.peerDid, at });
    const ourSig = rc.sign(body, this.identity.privateKey);
    const rid = ridOf(body);
    return new Promise((resolve, reject) => {
      s.pending.set(rid, { body, ourSig, resolve, reject });
      this.transport.send(sid, { t: "receipt_propose", body, sig: ourSig });
    });
  }

  // ── inbound ──────────────────────────────────────────────────────────────
  _onMessage(sid, msg) {
    try {
      switch (msg && msg.t) {
        case "hello": return this._onHello(sid, msg);
        case "hello_ack": return this._onHelloAck(sid, msg);
        case "auth": return this._onAuth(sid, msg);
        case "auth_ack": return this._onAuthAck(sid, msg);
        case "receipt_propose": return this._onReceiptPropose(sid, msg);
        case "receipt_cosign": return this._onReceiptCosign(sid, msg);
        case "error": return this._onError(sid, msg);
        default: return; // unknown message types are ignored, never trusted
      }
    } catch (e) {
      this._fail(sid, e.message);
    }
  }

  _onHello(sid, msg) {
    const s = this._session(sid, "responder");
    s.peerPresentation = msg.present || null; // UNTRUSTED until verified below
    const nonce = hs.challenge();
    s.nonceForPeer = nonce;
    s.nonceIssuedAt = this.now();
    this.transport.send(sid, { t: "hello_ack", present: this._presentation(), nonce });
  }

  _onHelloAck(sid, msg) {
    const s = this._session(sid, "initiator");
    s.peerPresentation = msg.present || null; // UNTRUSTED
    // Answer the peer's challenge, and challenge it back (mutual liveness).
    const sig = hs.respond(msg.nonce, this.identity.privateKey);
    const nonce = hs.challenge();
    s.nonceForPeer = nonce;
    s.nonceIssuedAt = this.now();
    this.transport.send(sid, { t: "auth", sig, nonce });
  }

  _onAuth(sid, msg) {
    const s = this._session(sid, "responder");
    if (!nonceFresh(s.nonceIssuedAt, this.now(), this.nonceTtlMs)) {
      return this._fail(sid, "challenge expired");
    }
    const v = hs.verifyResponse({ presentation: s.peerPresentation, nonce: s.nonceForPeer, signature: msg.sig });
    if (!v.ok) return this._fail(sid, `handshake rejected: ${v.reason}`);
    s.peerDid = v.did; // TRUSTED identity — derived from the proven key, not the envelope
    s.verified = true;
    this._emit("verified", { sessionId: sid, peerDid: s.peerDid, role: "responder" });
    // Answer the initiator's challenge so it can verify us in turn.
    const sig = hs.respond(msg.nonce, this.identity.privateKey);
    this.transport.send(sid, { t: "auth_ack", sig });
  }

  _onAuthAck(sid, msg) {
    const s = this.sessions.get(sid);
    if (!s) return;
    if (!nonceFresh(s.nonceIssuedAt, this.now(), this.nonceTtlMs)) {
      return this._fail(sid, "challenge expired");
    }
    const v = hs.verifyResponse({ presentation: s.peerPresentation, nonce: s.nonceForPeer, signature: msg.sig });
    if (!v.ok) return this._fail(sid, `handshake rejected: ${v.reason}`);
    s.peerDid = v.did; // TRUSTED
    s.verified = true;
    this._emit("verified", { sessionId: sid, peerDid: s.peerDid, role: "initiator" });
    if (s.connect) {
      s.connect.resolve({ sessionId: sid, peerDid: s.peerDid });
      s.connect = null;
    }
  }

  _onReceiptPropose(sid, msg) {
    const s = this.sessions.get(sid);
    if (!s || !s.verified) return this._fail(sid, "receipt before verified handshake");
    const body = msg.body || {};
    const sig = msg.sig || {};
    // Distrust the envelope: the proposed body MUST name the handshake-proven
    // peer as `from` and US as `to`, and its signature MUST be from that same
    // proven peer. A body that misnames the parties is refused, even if the
    // signature over it is internally valid — identity comes from the handshake.
    if (body.from !== s.peerDid || body.to !== this.selfDid) {
      return this._fail(sid, "receipt parties do not match verified peer");
    }
    if (sig.by !== s.peerDid) {
      return this._fail(sid, "receipt signer is not the verified peer");
    }
    const proposerOk = rc.verify({ receipt: body, sigs: [sig] }, { requireBoth: false });
    if (!proposerOk.ok) return this._fail(sid, `proposer signature invalid: ${proposerOk.reason}`);
    const ourSig = rc.sign(body, this.identity.privateKey);
    const cosigned = { receipt: body, sigs: [sig, ourSig] };
    const full = rc.verify(cosigned); // requireBoth — now a real two-party edge
    if (!full.ok) return this._fail(sid, `co-signed receipt invalid: ${full.reason}`);
    this.ledger.push(cosigned);
    this.transport.send(sid, { t: "receipt_cosign", rid: ridOf(body), sig: ourSig });
    this._emit("receipt", { sessionId: sid, cosigned });
  }

  _onReceiptCosign(sid, msg) {
    const s = this.sessions.get(sid);
    if (!s) return;
    const p = s.pending.get(msg.rid);
    if (!p) return this._fail(sid, "co-sign for an unknown receipt");
    s.pending.delete(msg.rid);
    const cosigned = { receipt: p.body, sigs: [p.ourSig, msg.sig] };
    const full = rc.verify(cosigned);
    if (!full.ok) return p.reject(new Error(`co-signed receipt invalid: ${full.reason}`));
    this.ledger.push(cosigned);
    this._emit("receipt", { sessionId: sid, cosigned });
    p.resolve(cosigned);
  }

  _onError(sid, msg) {
    // Don't answer an error with an error (no notify) — just unwind locally.
    this._fail(sid, `peer error: ${msg && msg.reason}`, false);
  }

  _fail(sid, reason, notify = true) {
    const s = this.sessions.get(sid);
    this._emit("error", { sessionId: sid, reason });
    if (notify) {
      try {
        this.transport.send(sid, { t: "error", reason });
      } catch (_) {
        /* transport may be one-shot/closed — local unwind below still happens */
      }
    }
    if (s) {
      if (s.connect) {
        s.connect.reject(new Error(reason));
        s.connect = null;
      }
      for (const [, p] of s.pending) p.reject(new Error(reason));
      s.pending.clear();
      s.verified = false;
    }
  }
}

module.exports = { A2ARouter, nonceFresh };
