"use strict";

// OpenAgent A2A profile builder (DIVE-730/761) — step 3 of the v1 platform: the
// `GET /a2a/agents/:did` view, kept pure and transport/datastore-neutral so the
// eventual service just serializes whatever this returns.
//
// A profile is an INDEX over self-certifying receipts, not a source of trust:
//   header — the agent's OpenAgent card (identity), passed in by the caller.
//   ledger — verifyHistory() recomputed from THIS did's stored receipts, every
//            line re-verified from its two signatures. We re-derive the counts
//            on read rather than trusting any stored aggregate; if the DB were
//            tampered, the math still wouldn't lie.
//
// Honest-counts guardrail: we surface RAW counts only — distinct counterparties
// and verified task count. No reputation/weighting is implied (sybil weighting
// is a public-launch gate, deferred). Copy stays "verified"/"co-signed", never
// "crypto"/"blockchain".

const rc = require("./receipts");

// Reconstruct the canonical cosign line ({ receipt, sigs }) verifyHistory and
// rc.verify expect, from a stored column-ready record.
function recordToLine(record) {
  return JSON.stringify({ receipt: record.body, sigs: [record.sigFrom, record.sigTo] });
}

// Build the public profile for `did` from a receipt store.
//   { did, store, card? } -> { did, header, ledger }
// `store` is any object with byDid(did) (see lib/a2a-store.js). `card` is the
// optional OpenAgent card header (whatever the caller resolved from the registry).
function buildProfile({ did, store, card = null }) {
  if (!did || typeof did !== "string") {
    return { ok: false, reason: "missing did" };
  }
  if (!store || typeof store.byDid !== "function") {
    return { ok: false, reason: "missing store" };
  }

  const records = store.byDid(did);
  // Re-verify every line from its signatures against THIS did — verifyHistory
  // dedups replays (sha256 PK), drops not-mine/self-loop/invalid, and returns
  // only honest raw counts.
  const lines = records.map(recordToLine);
  const ledger = rc.verifyHistory(lines, did);

  return {
    ok: true,
    profile: {
      did,
      header: card, // OpenAgent card, or null until resolved by the caller
      ledger: {
        taskCount: ledger.valid, // raw count of distinct verified co-signed receipts
        counterpartyCount: ledger.counterparties.length,
        counterparties: ledger.counterparties,
        // The verified receipt bodies (no sigs in the public view — those re-verify
        // via GET /a2a/receipts/:id/verify). Each is a real co-signed interaction.
        receipts: records
          .map((r) => ({ id: r.id, from: r.fromDid, to: r.toDid, task: r.body.task, result: r.body.result, at: r.at }))
          .sort((a, b) => String(b.at).localeCompare(String(a.at))),
      },
    },
  };
}

module.exports = { buildProfile, recordToLine };
