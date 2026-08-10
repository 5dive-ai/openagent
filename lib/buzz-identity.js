"use strict";

// The did:key <-> npub co-signed identity binding (DIVE-3138 item 2).
//
// Buzz identity is secp256k1 x-only BIP-340; OpenAgent identity is did:key over
// ed25519. THERE IS NO DERIVATION BETWEEN THEM (NIP-OA.md:22 declines to define
// one, and none exists in either direction). So the binding cannot be computed —
// it has to be ASSERTED BY BOTH KEYS and checked by a verifier. That is the whole
// design: an agent holds two keypairs, and this receipt is the only artefact
// tying them together.
//
// This is a NEW receipt type alongside lib/receipts.js rather than a call into
// its cosign(). receipts.cosign() assumes both halves are ed25519 and signs the
// same bytes with both; here the two halves take DIFFERENT INPUTS at different
// layers (see PREIMAGE VS DIGEST below), so reusing it would be wrong in a way
// that still produces two valid-looking signatures.

const crypto = require("crypto");
const {
  canonicalBytes,
  toPublicKey,
  toPrivateKey,
  publicPemFromPrivate,
  didKeyFromPublicKey,
} = require("./provenance");
const { npubEncode, npubDecode, schnorrPublicKey, schnorrSign, schnorrVerify } = require("./nostr");

// A DISTINCT domain separator. NIP-OA's is exactly `nostr:agent-auth:`
// (NIP-OA.md:44); ours must differ so neither signature can ever be replayed as
// the other. A schnorr signature over this binding must not also validate as an
// owner attestation, and vice versa.
const DOMAIN = "5dive:agent-identity-binding:v1:";

// Fields a statement may carry. Anything else makes it malformed — reject-on-
// ambiguity, borrowed from NIP-OA's own discipline (:28 two auth tags = no valid
// tag; :41 wrong element count = malformed).
const STATEMENT_FIELDS = new Set(["v", "did", "npub", "agent", "relay", "at", "nonce"]);

/**
 * Canonicalize a relay URL per NIP-AE.md:24 — lowercase scheme and host, strip a
 * default port (443 for wss/https, 80 for ws/http), strip a trailing slash on an
 * otherwise-empty path, path otherwise verbatim.
 *
 * The relay URL IS the community boundary, so a binding valid everywhere is a
 * binding that leaks across communities. Reused here rather than inventing a
 * second URL comparison.
 */
function canonicalizeRelay(url) {
  const u = new URL(String(url));
  const scheme = u.protocol.toLowerCase().replace(/:$/, "");
  const host = u.hostname.toLowerCase();
  const isSecure = scheme === "wss" || scheme === "https";
  const defaultPort = isSecure ? "443" : "80";
  const port = u.port && u.port !== defaultPort ? ":" + u.port : "";
  const path = u.pathname === "/" ? "" : u.pathname;
  return `${scheme}://${host}${port}${path}${u.search}`;
}

/**
 * The unsigned statement both keys agree on.
 * `at` is a claim, NOT an expiry — same reasoning as NIP-OA's created_at clauses
 * (NIP-OA.md:100-103): it is self-declared by the signers and verification MUST
 * NOT depend on the verifier's clock. Freshness, if needed, is enforced out of
 * band against our own receipts store.
 */
function buildBinding({ did, npub, agent, relay, at, nonce }) {
  if (!did || !npub || !agent || !relay || !at) {
    throw new Error("buildBinding: did, npub, agent, relay, at all required");
  }
  if (!String(did).startsWith("did:key:z")) throw new Error("buildBinding: did must be a did:key");
  const hexNpub = String(npub).startsWith("npub1") ? npubDecode(npub) : String(npub).toLowerCase();
  if (!hexNpub || !/^[0-9a-f]{64}$/.test(hexNpub)) {
    throw new Error("buildBinding: npub must be an npub1… or 64-char x-only hex");
  }
  return {
    v: 1,
    did: String(did),
    npub: npubEncode(hexNpub), // stored in bech32 so the signed bytes pin the encoding too
    agent: String(agent),
    relay: canonicalizeRelay(relay),
    at: Number(at),
    nonce: nonce ? String(nonce) : crypto.randomBytes(16).toString("hex"),
  };
}

// PREIMAGE VS DIGEST — this is not cosmetic, and it is where re-derivations die.
// Ed25519 hashes its message internally, so it signs the PREIMAGE. BIP-340 signs
// a 32-byte message, so it signs SHA256(preimage). Handing the same bytes to both
// is the mistake; both layers are pinned here and in test/buzz.js vectors.
function bindingPreimage(statement) {
  return Buffer.concat([Buffer.from(DOMAIN, "utf8"), canonicalBytes(statement)]);
}
function bindingDigest(statement) {
  return crypto.createHash("sha256").update(bindingPreimage(statement)).digest();
}

/** The did:key half: detached ed25519 over the PREIMAGE. */
function signDid(statement, privateKey) {
  const key = publicPemFromPrivate(privateKey);
  return {
    alg: "ed25519",
    by: didKeyFromPublicKey(key),
    key,
    sig: crypto.sign(null, bindingPreimage(statement), toPrivateKey(privateKey)).toString("base64"),
  };
}

/** The npub half: BIP-340 schnorr over the 32-byte DIGEST. */
function signNpub(statement, secretHex, aux32) {
  const pub = schnorrPublicKey(secretHex);
  return {
    alg: "bip340",
    by: npubEncode(pub),
    key: pub,
    sig: schnorrSign(bindingDigest(statement), secretHex, aux32 || crypto.randomBytes(32)),
  };
}

/** A fully co-signed binding = the statement + both halves. */
function cosignBinding(statement, edPrivateKey, nostrSecretHex, aux32) {
  return {
    statement,
    sigs: [signDid(statement, edPrivateKey), signNpub(statement, nostrSecretHex, aux32)],
  };
}

/**
 * Verify a co-signed binding. Never throws.
 *
 * With requireBoth (the default, and the only sane setting), BOTH halves must be
 * present and must verify against the keys the statement itself names. A
 * one-sided binding is worthless BY CONSTRUCTION — a single signature proves only
 * that one key made a claim about a key it does not control, which is exactly
 * the claim an attacker wants to make.
 *
 * @param {object} cosigned {statement, sigs}
 * @param {object} opts.requireBoth default true
 * @param {string} opts.relay if given, the statement's relay must canonicalize to it
 * @param {Set}    opts.seenNonces if given, `nonce` must be unseen for this (did,npub) pair
 */
function verifyBinding(cosigned, { requireBoth = true, relay = null, seenNonces = null } = {}) {
  const { statement, sigs } = cosigned || {};
  if (!statement || typeof statement !== "object" || !Array.isArray(sigs) || sigs.length === 0) {
    return { ok: false, reason: "malformed" };
  }
  if (statement.v !== 1) return { ok: false, reason: "unsupported statement version" };

  // Reject ANY unknown field. A receipt asserting derivation between the keys
  // (`derived_from`, `derivation`, …) is malformed, not merely wrong — no such
  // derivation exists, so a field claiming one is a lie the format must not carry.
  for (const k of Object.keys(statement)) {
    if (!STATEMENT_FIELDS.has(k)) return { ok: false, reason: `unknown statement field: ${k}` };
  }
  for (const k of STATEMENT_FIELDS) {
    if (statement[k] === undefined || statement[k] === null || statement[k] === "") {
      return { ok: false, reason: `missing statement field: ${k}` };
    }
  }

  const npubHex = npubDecode(statement.npub);
  if (!npubHex) return { ok: false, reason: "statement npub is not a valid NIP-19 npub" };

  if (relay) {
    let want;
    try {
      want = canonicalizeRelay(relay);
    } catch {
      return { ok: false, reason: "verifier relay unparseable" };
    }
    if (statement.relay !== want) return { ok: false, reason: "relay mismatch (wrong community)" };
  }

  const preimage = bindingPreimage(statement);
  const digest = crypto.createHash("sha256").update(preimage).digest();
  const seen = { ed25519: false, bip340: false };

  for (const s of sigs) {
    if (!s || !s.alg || !s.by || !s.key || !s.sig) return { ok: false, reason: "incomplete signature" };
    if (s.alg === "ed25519") {
      if (s.by !== statement.did) return { ok: false, reason: "ed25519 signer is not the statement did" };
      let derived;
      try {
        derived = didKeyFromPublicKey(s.key);
      } catch {
        return { ok: false, reason: "unparseable did key" };
      }
      if (derived !== s.by) return { ok: false, reason: "signer did/key mismatch" };
      let ok = false;
      try {
        ok = crypto.verify(null, preimage, toPublicKey(s.key), Buffer.from(String(s.sig), "base64"));
      } catch {
        ok = false;
      }
      if (!ok) return { ok: false, reason: "bad ed25519 signature" };
      seen.ed25519 = true;
    } else if (s.alg === "bip340") {
      if (String(s.key).toLowerCase() !== npubHex) {
        return { ok: false, reason: "bip340 signer is not the statement npub" };
      }
      if (s.by !== statement.npub) return { ok: false, reason: "bip340 by/npub mismatch" };
      if (!schnorrVerify(digest, npubHex, s.sig)) return { ok: false, reason: "bad bip340 signature" };
      seen.bip340 = true;
    } else {
      return { ok: false, reason: `unknown signature alg: ${s.alg}` };
    }
  }

  if (requireBoth && !(seen.ed25519 && seen.bip340)) {
    return { ok: false, reason: "one-sided binding (both did and npub must sign)" };
  }

  if (seenNonces) {
    const key = `${statement.did}|${statement.npub}|${statement.nonce}`;
    if (seenNonces.has(key)) return { ok: false, reason: "replayed nonce" };
    seenNonces.add(key);
  }

  return { ok: true, did: statement.did, npub: statement.npub, npubHex, agent: statement.agent };
}

module.exports = {
  DOMAIN,
  canonicalizeRelay,
  buildBinding,
  bindingPreimage,
  bindingDigest,
  signDid,
  signNpub,
  cosignBinding,
  verifyBinding,
};
