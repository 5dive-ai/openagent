"use strict";

// OpenAgent A2A verify-on-ingest (DIVE-730) — the trust gateway for the v1
// platform, kept transport- AND storage-neutral so it drops into whatever repo /
// datastore the "LinkedIn for agents" service lands in.
//
// A submission is an UNTRUSTED co-signed receipt ({ receipt, sigs }) posted to
// the platform. ingestReceipt re-verifies it from scratch and returns the
// normalized record a store should persist — or a rejection reason. The platform
// is an index over self-certifying receipts: it never holds a key and never
// signs; it only re-checks the math before indexing.
//
// The cardinal rule (mirrors a2aRouter's "never trust envelope.from"): the
// stored from_did/to_did come from the VERIFIED receipt body, and are honored
// ONLY because rc.verify(requireBoth) proved both of those dids actually signed
// it. Any request-level "from"/"to"/"id" fields a caller tacks on are ignored —
// identity is whoever holds the key, derived from the signatures.
//
// Replay/dedup is the store's job: the natural key is `id` = sha256 of the
// canonical body, so a duplicate submission collides on the primary key. This
// module surfaces that id; it does not keep state.

const crypto = require("crypto");
const rc = require("./receipts");
const { canonicalBytes } = require("./provenance");

// Stable, content-addressed id: the same key verifyHistory dedups on and the
// store's primary key. Two byte-identical receipts → one id → natural replay
// collision.
function receiptId(body) {
  return crypto.createHash("sha256").update(canonicalBytes(body)).digest("hex");
}

// Verify a submitted co-signed receipt and normalize it for storage.
//   input:  { receipt, sigs } — as produced by rc.cosign(), from an untrusted caller
//   output: { ok:true, record } | { ok:false, reason }
// `record` = { id, fromDid, toDid, body, sigFrom, sigTo, at } — column-ready,
// every field derived from verified content, nothing from request envelope.
function ingestReceipt(submitted) {
  if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) {
    return { ok: false, reason: "malformed submission" };
  }
  // rc.verify(requireBoth) does the heavy lifting and the guardrails in one pass:
  //  - every signature verifies over the canonical body, and each signer's did
  //    matches its embedded key (no did/key spoofing),
  //  - the body is not self-addressed (from === to is rejected — not an edge),
  //  - both named parties (receipt.from, receipt.to) are among the signers
  //    (a one-sided or wrong-party receipt is rejected).
  const v = rc.verify(submitted, { requireBoth: true });
  if (!v.ok) return { ok: false, reason: v.reason };

  const body = submitted.receipt;
  // Identity is sig-backed: these dids are trustworthy ONLY because verify just
  // proved they signed. Pull each party's signature object for columnar storage.
  const sigFrom = submitted.sigs.find((s) => s && s.by === body.from) || null;
  const sigTo = submitted.sigs.find((s) => s && s.by === body.to) || null;
  if (!sigFrom || !sigTo) {
    // Unreachable under requireBoth (verify already proved both are signers), but
    // fail closed rather than persist a half-attributed row.
    return { ok: false, reason: "missing a party's signature" };
  }

  return {
    ok: true,
    record: {
      id: receiptId(body),
      fromDid: body.from,
      toDid: body.to,
      body, // canonical { v, task, result, from, to, at }
      sigFrom, // { by, key, sig }
      sigTo,
      at: body.at,
    },
  };
}

module.exports = { ingestReceipt, receiptId };
