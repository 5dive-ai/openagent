"use strict";

// OpenAgent A2A handshake (DIVE-730) — the liveness half of "prove who you are".
//
// The persona file's provenance signature already proves a file was authored by
// a key (trust-on-first-use). But a copied file proves nothing about the peer
// you're talking to RIGHT NOW. The handshake closes that: a fresh single-use
// nonce, signed live by the private half, proves the peer currently holds the
// key its did:key names. Pairs with the signed registry (lib/registry.js) which
// resolves a handle -> official did; together = "who, and live".
//
// This is verifiable-credentials / challenge-response. No chain, no token, no
// wallet — just an ed25519 signature over a nonce, reusing the same primitives
// as provenance signing.

const crypto = require("crypto");
const {
  toPublicKey,
  toPrivateKey,
  publicPemFromPrivate,
  didKeyFromPublicKey,
} = require("./provenance");

// What an agent presents when it initiates contact: its did:key, the public key
// that did derives from, and (optionally) a handle/card URL the verifier can
// resolve against a signed registry for the OFFICIAL identity. No secrets here.
function present({ privateKey, handle = null, cardUrl = null }) {
  if (!privateKey) throw new Error("present: privateKey required");
  const key = publicPemFromPrivate(privateKey);
  return { v: 1, did: didKeyFromPublicKey(key), key, handle, cardUrl };
}

// The verifier issues a fresh, single-use challenge. 256 bits of randomness =
// not guessable, not replayable (each handshake gets its own).
function challenge() {
  return crypto.randomBytes(32).toString("base64");
}

// The presenter proves liveness by signing the verifier's nonce with the
// private half of the key it presented.
function respond(nonce, privateKey) {
  if (!nonce) throw new Error("respond: nonce required");
  return crypto
    .sign(null, Buffer.from(String(nonce), "utf8"), toPrivateKey(privateKey))
    .toString("base64");
}

// The verifier checks two things:
//  (a) the presented did:key actually derives from the presented public key —
//      so a peer can't claim someone else's did, and
//  (b) the signature over THIS nonce verifies against that key — so the peer
//      holds the private half right now, not just a copy of a public file.
function verifyResponse({ presentation, nonce, signature } = {}) {
  const { did, key } = presentation || {};
  if (!did || !key) return { ok: false, reason: "missing did/key" };
  if (!nonce || !signature) return { ok: false, reason: "missing nonce/signature" };

  let derived;
  try {
    derived = didKeyFromPublicKey(key);
  } catch {
    return { ok: false, reason: "unparseable key" };
  }
  if (derived !== did) return { ok: false, reason: "did/key mismatch" };

  let valid = false;
  try {
    valid = crypto.verify(
      null,
      Buffer.from(String(nonce), "utf8"),
      toPublicKey(key),
      Buffer.from(String(signature), "base64"),
    );
  } catch {
    return { ok: false, reason: "verify error" };
  }
  return valid
    ? { ok: true, did, reason: "live key ownership proven" }
    : { ok: false, reason: "bad signature" };
}

module.exports = { present, challenge, respond, verifyResponse };
