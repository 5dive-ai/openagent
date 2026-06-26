"use strict";

// DIVE-730 round-trip: proves the work-history thesis mechanic end-to-end with
// real ed25519 keys — handshake liveness + co-signed receipts + portable history.
// Run: node test/a2a.js

const assert = require("assert");
const { generateKeypair } = require("../lib/provenance");
const hs = require("../lib/handshake");
const rc = require("../lib/receipts");

let n = 0;
const ok = (c, m) => {
  assert(c, m);
  n++;
};

// two independent agents
const A = generateKeypair();
const B = generateKeypair();

// ── handshake ──────────────────────────────────────────────────────────────
const presA = hs.present({ privateKey: A.privateKey, handle: "marcus" });
ok(presA.did.startsWith("did:key:"), "present yields a did:key");

const nonce = hs.challenge();
const respA = hs.respond(nonce, A.privateKey);
ok(hs.verifyResponse({ presentation: presA, nonce, signature: respA }).ok, "live key ownership proven");

// impostor: B signs but presents A's identity → must fail
ok(
  !hs.verifyResponse({ presentation: presA, nonce, signature: hs.respond(nonce, B.privateKey) }).ok,
  "impostor signature rejected",
);

// nonce-bound: yesterday's signature can't answer today's challenge
ok(
  !hs.verifyResponse({ presentation: presA, nonce: hs.challenge(), signature: respA }).ok,
  "replayed signature rejected (nonce-bound)",
);

// did/key tamper: claim A's did with B's key → must fail
ok(
  !hs.verifyResponse({ presentation: { did: presA.did, key: hs.present({ privateKey: B.privateKey }).key }, nonce, signature: respA }).ok,
  "did/key mismatch rejected",
);

// ── co-signed receipts ───────────────────────────────────────────────────────
const presB = hs.present({ privateKey: B.privateKey });
const receipt = rc.buildReceipt({
  taskHash: rc.hash("build the login fix"),
  resultHash: rc.hash("PR #214 merged"),
  fromDid: presA.did,
  toDid: presB.did,
  at: "2026-06-26T12:00:00Z",
});

const co = rc.cosign(receipt, A.privateKey, B.privateKey);
ok(rc.verify(co).ok, "co-signed receipt verifies");

// one signature is not an edge
ok(!rc.verify({ receipt, sigs: [rc.sign(receipt, A.privateKey)] }).ok, "one-sided receipt rejected");

// tampered body invalidates both sigs
ok(
  !rc.verify({ receipt: { ...receipt, result: rc.hash("nope") }, sigs: co.sigs }).ok,
  "tampered receipt body rejected",
);

// a stranger's signature can't stand in for a named party
const C = generateKeypair();
ok(
  !rc.verify({ receipt, sigs: [rc.sign(receipt, A.privateKey), rc.sign(receipt, C.privateKey)] }).ok,
  "wrong counterparty signature rejected",
);

// ── portable history (the profile's earned ledger) ──────────────────────────
const r2 = rc.buildReceipt({
  taskHash: rc.hash("ship german pricing"),
  resultHash: rc.hash("live"),
  fromDid: presA.did,
  toDid: hs.present({ privateKey: C.privateKey }).did,
  at: "2026-06-26T13:00:00Z",
});
const history = [JSON.stringify(co), JSON.stringify(rc.cosign(r2, A.privateKey, C.privateKey))];
const summary = rc.verifyHistory(history, presA.did);
ok(summary.valid === 2 && summary.counterparties.length === 2 && summary.bad.length === 0,
  "history: 2 verified receipts across 2 distinct counterparties");

// can't pad your record with a receipt you're not party to
const outsider = rc.cosign(
  rc.buildReceipt({ taskHash: rc.hash("x"), resultHash: rc.hash("y"), fromDid: presB.did, toDid: hs.present({ privateKey: C.privateKey }).did, at: "2026-06-26T14:00:00Z" }),
  B.privateKey, C.privateKey,
);
ok(rc.verifyHistory([JSON.stringify(outsider)], presA.did).valid === 0, "foreign receipt not credited to self");

console.log(`A2A handshake + co-signed receipts: ALL ${n} CHECKS PASS`);
