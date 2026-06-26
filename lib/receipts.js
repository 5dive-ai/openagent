"use strict";

// OpenAgent co-signed work receipts (DIVE-730) — the verifiable-history half.
//
// The thesis: a network's value is the un-fakeable EDGES between agents, not the
// cards. A receipt is the edge. After two agents do a piece of work, BOTH sign
// the same canonical body {task, result, from, to, at}. Two detached ed25519
// signatures over identical bytes — that's it. No chain, no consensus, no token:
// there's no double-spend to prevent, you're only proving "both parties attest
// this happened." Accumulate receipts into a portable append-only history
// referenced by the card and you get a work record that cannot be self-claimed
// or forged ("240 tasks, 18 distinct counterparties", every line checkable).
//
// Signatures + did:key derivation reuse lib/provenance.js verbatim, so a receipt
// signature is byte-identical in scheme to a card's provenance signature.

const crypto = require("crypto");
const {
  canonicalBytes,
  toPublicKey,
  toPrivateKey,
  publicPemFromPrivate,
  didKeyFromPublicKey,
} = require("./provenance");

function hash(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

// The unsigned body both parties agree on. task/result are content hashes the
// caller supplies (use hash() on raw text); from/to are did:keys.
function buildReceipt({ taskHash, resultHash, fromDid, toDid, at }) {
  if (!taskHash || !resultHash || !fromDid || !toDid || !at) {
    throw new Error("buildReceipt: taskHash, resultHash, fromDid, toDid, at all required");
  }
  return { v: 1, task: taskHash, result: resultHash, from: fromDid, to: toDid, at };
}

// One party's signature over the canonical receipt body. `by` is the signer's
// did:key, `key` the public half it derives from (self-contained verification).
function sign(receipt, privateKey) {
  const key = publicPemFromPrivate(privateKey);
  return {
    by: didKeyFromPublicKey(key),
    key,
    sig: crypto.sign(null, canonicalBytes(receipt), toPrivateKey(privateKey)).toString("base64"),
  };
}

// A fully co-signed receipt = the body + both parties' signatures over it.
function cosign(receipt, fromPrivateKey, toPrivateKey_) {
  return { receipt, sigs: [sign(receipt, fromPrivateKey), sign(receipt, toPrivateKey_)] };
}

// Verify a co-signed receipt. Every signature must (a) verify over the body and
// (b) have its `by` did match its `key`. With requireBoth, both named parties
// (receipt.from and receipt.to) must be among the signers — a one-sided receipt
// is not an edge.
function verify(cosigned, { requireBoth = true } = {}) {
  const { receipt, sigs } = cosigned || {};
  if (!receipt || !Array.isArray(sigs) || sigs.length === 0) {
    return { ok: false, reason: "malformed" };
  }
  const bytes = canonicalBytes(receipt);
  const signers = new Set();
  for (const s of sigs) {
    if (!s || !s.key || !s.by || !s.sig) return { ok: false, reason: "incomplete signature" };
    let derived;
    try {
      derived = didKeyFromPublicKey(s.key);
    } catch {
      return { ok: false, reason: "unparseable signer key" };
    }
    if (derived !== s.by) return { ok: false, reason: "signer did/key mismatch" };
    let ok = false;
    try {
      ok = crypto.verify(null, bytes, toPublicKey(s.key), Buffer.from(String(s.sig), "base64"));
    } catch {
      ok = false;
    }
    if (!ok) return { ok: false, reason: `bad signature from ${s.by}` };
    signers.add(s.by);
  }
  if (requireBoth) {
    // A self-addressed receipt (from === to) is NOT an edge: one self-signature
    // would otherwise satisfy both parties and let an agent self-mint reputation.
    // Reject it — the whole point is that edges can't be self-claimed.
    if (receipt.from === receipt.to) return { ok: false, reason: "not an edge (self-addressed receipt)" };
    if (!signers.has(receipt.from) || !signers.has(receipt.to)) {
      return { ok: false, reason: "missing a party's signature" };
    }
  }
  return { ok: true, signers: [...signers] };
}

// Verify a portable history (array of JSONL lines, each a co-signed receipt) and
// summarize it the way a profile would: how many receipts verify, and how many
// DISTINCT counterparties this agent has provable edges with. Receipts that
// don't name `selfDid` are rejected (you can't pad your record with strangers').
function verifyHistory(lines, selfDid) {
  let total = 0;
  let valid = 0;
  const counterparties = new Set();
  const bad = [];
  for (const line of lines) {
    if (!String(line).trim()) continue;
    total++;
    let c;
    try {
      c = JSON.parse(line);
    } catch {
      bad.push("parse");
      continue;
    }
    const v = verify(c);
    if (!v.ok) {
      bad.push(v.reason);
      continue;
    }
    if (selfDid && c.receipt.from !== selfDid && c.receipt.to !== selfDid) {
      bad.push("not-mine");
      continue;
    }
    // Belt-and-suspenders: never count a self-addressed receipt or credit self as
    // a counterparty (verify() already rejects these under requireBoth).
    if (c.receipt.from === c.receipt.to) {
      bad.push("self-loop");
      continue;
    }
    valid++;
    if (selfDid) counterparties.add(c.receipt.from === selfDid ? c.receipt.to : c.receipt.from);
  }
  return { total, valid, counterparties: [...counterparties], bad };
}

module.exports = { hash, buildReceipt, sign, cosign, verify, verifyHistory };
