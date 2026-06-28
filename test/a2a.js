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

// replay-resistance: the same receipt relayed/submitted twice counts ONCE
ok(rc.verifyHistory([JSON.stringify(co), JSON.stringify(co)], presA.did).valid === 1,
  "duplicate receipt counted once (replay-resistant ledger)");

// self-addressed receipt (from === to) is NOT an edge — blocks self-minted
// reputation even though one signer "covers" both named parties.
const selfLoop = rc.buildReceipt({
  taskHash: rc.hash("self"), resultHash: rc.hash("self"),
  fromDid: presA.did, toDid: presA.did, at: "2026-06-26T15:00:00Z",
});
ok(!rc.verify(rc.cosign(selfLoop, A.privateKey, A.privateKey)).ok, "self-addressed receipt rejected (not an edge)");
ok(rc.verifyHistory([JSON.stringify(rc.cosign(selfLoop, A.privateKey, A.privateKey))], presA.did).valid === 0,
  "self-loop not credited in history (no self-counterparty)");

// can't pad your record with a receipt you're not party to
const outsider = rc.cosign(
  rc.buildReceipt({ taskHash: rc.hash("x"), resultHash: rc.hash("y"), fromDid: presB.did, toDid: hs.present({ privateKey: C.privateKey }).did, at: "2026-06-26T14:00:00Z" }),
  B.privateKey, C.privateKey,
);
ok(rc.verifyHistory([JSON.stringify(outsider)], presA.did).valid === 0, "foreign receipt not credited to self");

// DIVE-761: a short human label rides INSIDE the signed body, so a feed can show
// it without trusting unsigned/forgeable text. Tampering the title breaks verify.
const titled = rc.buildReceipt({
  taskHash: rc.hash("ship login fix"), resultHash: rc.hash("PR #214 merged"),
  fromDid: presA.did, toDid: presB.did, at: "2026-06-26T16:00:00Z",
  title: "shipped the login fix",
});
ok(titled.title === "shipped the login fix", "title rides in the receipt body");
const titledCo = rc.cosign(titled, A.privateKey, B.privateKey);
ok(rc.verify(titledCo).ok, "titled co-signed receipt verifies");
ok(!rc.verify({ receipt: { ...titled, title: "shipped a $1M deal" }, sigs: titledCo.sigs }).ok,
  "tampered title rejected (title is signed, not free-text caption)");
const untitled = rc.buildReceipt({
  taskHash: rc.hash("a"), resultHash: rc.hash("b"), fromDid: presA.did, toDid: presB.did, at: "2026-06-26T16:30:00Z",
});
ok(untitled.title === undefined, "receipt without title omits the field (back-compat)");

// ── store + profile: the centralized index over self-certifying receipts ─────
// DIVE-761 step 2/3: ingest re-verifies a submission -> store persists the
// column-ready record (dedup on the sha256 PK) -> buildProfile recomputes the
// verified ledger on read. Datastore-neutral (in-memory adapter); the Postgres
// service mirrors the same put/get/byDid/byDid interface.
const { createMemoryStore } = require("../lib/a2a-store");
const { buildProfile } = require("../lib/a2a-profile");
const ingest = require("../lib/a2a-ingest").ingestReceipt;

const store = createMemoryStore();
// A<->B and A<->C, both real co-signed receipts, ingested as untrusted submissions.
const subAB = ingest(co);
ok(subAB.ok && store.put(subAB.record).stored, "verified A-B receipt ingests and stores");
const subAC = ingest(rc.cosign(r2, A.privateKey, C.privateKey));
ok(subAC.ok && store.put(subAC.record).stored, "verified A-C receipt ingests and stores");

// Replay: the identical submission collides on the content-addressed PK.
ok(store.put(subAB.record).stored === false, "replayed receipt rejected by store PK (dedup)");
ok(store.size === 2, "store holds two distinct receipts after a replay attempt");
ok(store.byDid(presA.did).length === 2, "byDid indexes both of A's receipts");
ok(store.byDid(presB.did).length === 1, "byDid indexes only B's one receipt");

// Profile = card header + honest raw ledger, re-verified from signatures on read.
const profA = buildProfile({ did: presA.did, store, card: { handle: "marcus" } });
ok(profA.ok, "buildProfile succeeds for a known did");
ok(profA.profile.ledger.taskCount === 2, "A's ledger shows 2 verified tasks (raw count)");
ok(profA.profile.ledger.counterpartyCount === 2, "A's ledger shows 2 distinct counterparties");
ok(profA.profile.header.handle === "marcus", "profile carries the OpenAgent card header");
ok(profA.profile.ledger.receipts.every((r) => !("sigFrom" in r) && !("sigTo" in r)),
  "public profile view omits raw signatures (re-verify is a separate endpoint)");
const profB = buildProfile({ did: presB.did, store });
ok(profB.profile.ledger.taskCount === 1 && profB.profile.header === null,
  "B's profile = 1 task, null header until a card is resolved");
const profUnknown = buildProfile({ did: hs.present({ privateKey: C.privateKey }).did, store });
ok(profUnknown.profile.ledger.taskCount === 1, "C is credited for the one receipt it co-signed");

// ── loopback dry-run: two keystores, two "boxes", full canary loop ───────────
// DIVE-730 step 1: present->challenge->respond->verify + co-sign a receipt over
// the transport-agnostic a2aRouter, driven by the in-memory loopback adapter.
// Two SEPARATE keystores (two OPENAGENT_HOME dirs) stand in for two boxes — the
// same code path the v1 platform's mediated co-sign will reuse.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loopbackPair } = require("../lib/a2a-transport");
const { A2ARouter, nonceFresh } = require("../lib/a2a-router");
const { ingestReceipt, receiptId } = require("../lib/a2a-ingest");
const keystore = require("../lib/keystore");

const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  // nonceFresh windows the verifier-side TTL (pure, timer-free).
  ok(nonceFresh(1000, 1500, 1000) === true && nonceFresh(1000, 2500, 1000) === false,
    "nonceFresh windows the challenge by TTL");

  // ── verify-on-ingest (the platform trust gateway, storage-neutral) ─────────
  // Re-verifies an untrusted submission and normalizes it; from/to are derived
  // from the verified sigs, replay id = canonical-body sha256.
  {
    const P = generateKeypair();
    const Q = generateKeypair();
    const pDid = hs.present({ privateKey: P.privateKey }).did;
    const qDid = hs.present({ privateKey: Q.privateKey }).did;
    const body = rc.buildReceipt({
      taskHash: rc.hash("ingest task"), resultHash: rc.hash("ingest done"),
      fromDid: pDid, toDid: qDid, at: "2026-06-28T02:00:00Z",
    });
    const good = rc.cosign(body, P.privateKey, Q.privateKey);

    const ing = ingestReceipt(good);
    ok(ing.ok && ing.record.fromDid === pDid && ing.record.toDid === qDid,
      "ingest accepts a valid co-signed receipt, from/to derived from the sigs");
    ok(ing.record.id === receiptId(body) && ing.record.sigFrom.by === pDid && ing.record.sigTo.by === qDid,
      "ingest record carries the content-addressed id + each party's signature");

    // request-field spoofing is inert — identity comes from verified content,
    // not from extra fields a caller tacks onto the submission.
    const spoofed = { ...good, from: "did:key:zEVIL", to: "did:key:zEVIL", id: "deadbeef" };
    const ing2 = ingestReceipt(spoofed);
    ok(ing2.ok && ing2.record.fromDid === pDid && ing2.record.toDid === qDid && ing2.record.id === receiptId(body),
      "ingest ignores spoofed request-level from/to/id fields");

    ok(!ingestReceipt({ receipt: { ...body, result: rc.hash("tampered") }, sigs: good.sigs }).ok,
      "ingest rejects a tampered body");
    ok(!ingestReceipt({ receipt: body, sigs: [good.sigs[0]] }).ok,
      "ingest rejects a one-sided receipt");
    const selfBody = rc.buildReceipt({ taskHash: rc.hash("s"), resultHash: rc.hash("s"), fromDid: pDid, toDid: pDid, at: "2026-06-28T03:00:00Z" });
    ok(!ingestReceipt(rc.cosign(selfBody, P.privateKey, P.privateKey)).ok,
      "ingest rejects a self-addressed receipt (not an edge)");
    ok(!ingestReceipt(null).ok && !ingestReceipt({ sigs: [] }).ok,
      "ingest rejects malformed submissions");
  }

  // Two independent keystores = two boxes, each its own stable did:key.
  const prevHome = process.env.OPENAGENT_HOME;
  const homeA = fs.mkdtempSync(path.join(os.tmpdir(), "oa-a2a-a-"));
  const homeB = fs.mkdtempSync(path.join(os.tmpdir(), "oa-a2a-b-"));
  process.env.OPENAGENT_HOME = homeA;
  const idA = keystore.loadOrCreateAgentKey();
  process.env.OPENAGENT_HOME = homeB;
  const idB = keystore.loadOrCreateAgentKey();
  ok(idA.did !== idB.did && idA.created && idB.created, "two keystores mint two distinct box identities");

  try {
    // ── happy path: handshake + co-signed receipt over the loopback ──────────
    const wire = loopbackPair();
    const routerA = new A2ARouter({ identity: idA, transport: wire.a, handle: "marcus" });
    const routerB = new A2ARouter({ identity: idB, transport: wire.b, handle: "lilbro" });

    const { sessionId, peerDid } = await routerA.connect("B");
    ok(peerDid === idB.did, "initiator verified the responder's did via the live handshake");
    ok(routerB.verifiedPeer(sessionId) === idA.did, "responder verified the initiator's did via the live handshake");

    const cosigned = await routerA.closeTask(sessionId, {
      taskHash: rc.hash("ship the DIVE-730 canary"),
      resultHash: rc.hash("loopback green"),
      at: "2026-06-28T00:00:00Z",
    });
    ok(rc.verify(cosigned).ok, "task-close yields a verifying co-signed receipt");
    ok(routerA.ledger.length === 1 && routerB.ledger.length === 1, "both boxes hold the co-signed edge");

    const summary = rc.verifyHistory(routerA.ledger.map((c) => JSON.stringify(c)), idA.did);
    ok(summary.valid === 1 && summary.counterparties.length === 1 && summary.counterparties[0] === idB.did,
      "verifyHistory shows the cross-box co-signed entry");

    // ── identity-from-handshake, NOT envelope: a validly-signed receipt that
    // names a DIFFERENT party than the verified peer is refused. ──────────────
    const C = generateKeypair();
    const cDid = hs.present({ privateKey: C.privateKey }).did;
    let bErr = null;
    routerB.on("error", (e) => { bErr = e.reason; });
    const before = routerB.ledger.length;
    const forgedBody = rc.buildReceipt({
      taskHash: rc.hash("forged"), resultHash: rc.hash("forged"),
      fromDid: cDid, toDid: idB.did, at: "2026-06-28T01:00:00Z",
    });
    wire.a.send(sessionId, { t: "receipt_propose", body: forgedBody, sig: rc.sign(forgedBody, C.privateKey) });
    await tick();
    ok(routerB.ledger.length === before && /do not match verified peer/.test(bErr || ""),
      "receipt naming a non-handshake party is refused (identity from handshake, not envelope)");

    // ── verifier-side nonce TTL: an expired challenge fails the handshake. ────
    // The verifier's clock returns t0 when it issues the nonce, then jumps past
    // the TTL before the response arrives — deterministic, no real sleeping.
    const wire2 = loopbackPair();
    let ticks = 0;
    const expiringNow = () => (ticks++ === 0 ? 1000 : 1000 + 10_000);
    const rA = new A2ARouter({ identity: idA, transport: wire2.a });
    new A2ARouter({ identity: idB, transport: wire2.b, nonceTtlMs: 1000, now: expiringNow });
    let expiredReason = "";
    try {
      await rA.connect("B");
    } catch (e) {
      expiredReason = e.message;
    }
    ok(/expired/.test(expiredReason), "verifier-side nonce TTL rejects a stale challenge");
  } finally {
    if (prevHome === undefined) delete process.env.OPENAGENT_HOME;
    else process.env.OPENAGENT_HOME = prevHome;
    fs.rmSync(homeA, { recursive: true, force: true });
    fs.rmSync(homeB, { recursive: true, force: true });
  }

  console.log(`A2A handshake + co-signed receipts + loopback dry-run: ALL ${n} CHECKS PASS`);
})().catch((e) => {
  console.error("A2A test failed:", e);
  process.exit(1);
});
