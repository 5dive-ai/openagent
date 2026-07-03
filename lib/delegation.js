"use strict";

// OpenAgent rotatable-root identity anchor (DIVE-949 / spec DIVE-936).
//
// Today an OpenAgent identity IS a single did:key: every receipt is signed by
// the one key, so the key can't rotate without orphaning history, and there's no
// org->agent->role hierarchy in the signed artifact. This module adds the
// missing layer WITHOUT a central registry: a stable *root* anchor delegates
// day-to-day signing to short-lived *leaf* keys via a self-contained, signed
// **delegation statement**. History attributes to the root, so reputation
// survives key rotation.
//
//   root (stable, reputation-bearing)  --delegation-->  leaf (rotatable signer)
//
// A delegation is the same {by,key,sig} ed25519 envelope receipts already use
// (lib/receipts.js), over the same canonical bytes, so it cross-verifies with
// the shipped Ed25519 receipt vectors. The leaf's receipt signature is entirely
// unchanged — delegation is a strictly ADDITIVE layer.
//
// HARD backward-compat guarantee: a receipt with NO delegation is treated as
// self-anchored (leaf == root == the single key — today's behaviour, the
// degenerate case). Every shipped single-key consumer (crew receipts, zerohuman
// feed, openagent-crewai OPT-1 co-signs) keeps verifying unchanged; consumers
// opt into the delegation walk only when they want root-attribution / rotation.

const crypto = require("crypto");
const {
  stableStringify,
  toPublicKey,
  toPrivateKey,
  publicPemFromPrivate,
  didKeyFromPublicKey,
} = require("./provenance");

const DELEGATION_TYP = "openagent/delegation";
const REVOCATION_TYP = "openagent/revocation";

// The exact bytes a statement's `sig` covers: the whole statement with `sig`
// removed. Same JCS-equivalent canonicalization as receipts — object keys sorted
// recursively, no insignificant whitespace — so a YAML/JSON round-trip that
// reorders keys never breaks a signature. Round-trips through JSON to drop
// undefined (an absent optional `role` is signed as absent, not as null).
function canonicalStatementBytes(statement) {
  const clone = JSON.parse(JSON.stringify(statement));
  delete clone.sig;
  return Buffer.from(stableStringify(clone), "utf8");
}

// A root's signature over a statement body. `by` is the root did:key, `key` the
// public half it derives from — self-contained verification, no lookup.
function signStatement(body, rootPrivateKey) {
  const key = publicPemFromPrivate(rootPrivateKey);
  return {
    by: didKeyFromPublicKey(key),
    key,
    sig: crypto
      .sign(null, canonicalStatementBytes(body), toPrivateKey(rootPrivateKey))
      .toString("base64"),
  };
}

// ---- build -----------------------------------------------------------------

/**
 * Build a signed delegation statement: "leaf L may act as [me | role R] in
 * [not_before, not_after)". Signed by the root private key. Self-contained.
 *
 * @param {object} o
 * @param {string} o.rootPrivateKey  the stable anchor's private key (the signer)
 * @param {string} o.leafDid         the authorized signing key (did:key)
 * @param {string} [o.role]          optional role this leaf acts as (OPT-2 edges)
 * @param {string} o.notBefore       ISO8601 lower bound (inclusive)
 * @param {string|null} [o.notAfter] ISO8601 upper bound (exclusive), or null =
 *                                    until revoked. Prefer a bounded, short TTL.
 * @returns {object} the signed delegation statement
 */
function buildDelegation({ rootPrivateKey, leafDid, role = null, notBefore, notAfter = null }) {
  if (!rootPrivateKey) throw new Error("buildDelegation: rootPrivateKey required");
  if (!leafDid || !String(leafDid).startsWith("did:key:")) {
    throw new Error("buildDelegation: leafDid must be a did:key");
  }
  if (!notBefore) throw new Error("buildDelegation: notBefore (ISO8601) required");
  const body = {
    v: 1,
    typ: DELEGATION_TYP,
    root: didKeyFromPublicKey(publicPemFromPrivate(rootPrivateKey)),
    leaf: leafDid,
    not_before: notBefore,
    not_after: notAfter, // null = until revoked
  };
  // Optional role rides INSIDE the signed body (per-role reputation edges,
  // DIVE-936 OPT-2). Added only when present, so a role-less delegation builds
  // byte-identically to one that never had the field.
  if (role) body.role = String(role);
  return { ...body, sig: signStatement(body, rootPrivateKey) };
}

/**
 * Build a signed revocation statement — root revokes a leaf. Registry-free: it
 * propagates alongside receipts / on the a2a feed (distribution is the classic
 * hard part; v1 leans on short-lived leaves as the primary bound, revocation as
 * a secondary signal — an honest tradeoff, not solved centrally).
 */
function buildRevocation({ rootPrivateKey, leafDid, revokedAt, role = null }) {
  if (!rootPrivateKey) throw new Error("buildRevocation: rootPrivateKey required");
  if (!leafDid || !String(leafDid).startsWith("did:key:")) {
    throw new Error("buildRevocation: leafDid must be a did:key");
  }
  if (!revokedAt) throw new Error("buildRevocation: revokedAt (ISO8601) required");
  const body = {
    v: 1,
    typ: REVOCATION_TYP,
    root: didKeyFromPublicKey(publicPemFromPrivate(rootPrivateKey)),
    leaf: leafDid,
    revoked_at: revokedAt,
  };
  if (role) body.role = String(role);
  return { ...body, sig: signStatement(body, rootPrivateKey) };
}

// ---- verify (crypto + structure) -------------------------------------------

// Verify a statement's `sig`: it must (a) verify over the canonical body and
// (b) have its `by` did derive from its `key`, AND that did must equal the
// statement's declared `root` (a delegation is only meaningful signed by the
// root it names). Returns {ok, reason?}. Time-window / revocation are contextual
// and checked by the attribution walk, not here.
function verifyStatementSig(statement, expectTyp) {
  if (!statement || typeof statement !== "object") return { ok: false, reason: "malformed" };
  if (expectTyp && statement.typ !== expectTyp) {
    return { ok: false, reason: `wrong typ (expected ${expectTyp})` };
  }
  const s = statement.sig;
  if (!s || !s.key || !s.by || !s.sig) return { ok: false, reason: "incomplete signature" };
  let derived;
  try {
    derived = didKeyFromPublicKey(s.key);
  } catch {
    return { ok: false, reason: "unparseable signer key" };
  }
  if (derived !== s.by) return { ok: false, reason: "signer did/key mismatch" };
  if (statement.root && s.by !== statement.root) {
    return { ok: false, reason: "not signed by the declared root" };
  }
  let ok = false;
  try {
    ok = crypto.verify(
      null,
      canonicalStatementBytes(statement),
      toPublicKey(s.key),
      Buffer.from(String(s.sig), "base64"),
    );
  } catch {
    ok = false;
  }
  if (!ok) return { ok: false, reason: "bad signature" };
  return { ok: true };
}

function verifyDelegation(delegation) {
  const v = verifyStatementSig(delegation, DELEGATION_TYP);
  if (!v.ok) return v;
  if (!String(delegation.leaf || "").startsWith("did:key:")) {
    return { ok: false, reason: "leaf is not a did:key" };
  }
  if (!delegation.not_before) return { ok: false, reason: "missing not_before" };
  return {
    ok: true,
    root: delegation.root,
    leaf: delegation.leaf,
    role: delegation.role || null,
    not_before: delegation.not_before,
    not_after: delegation.not_after ?? null,
  };
}

function verifyRevocation(revocation) {
  const v = verifyStatementSig(revocation, REVOCATION_TYP);
  if (!v.ok) return v;
  return {
    ok: true,
    root: revocation.root,
    leaf: revocation.leaf,
    role: revocation.role || null,
    revoked_at: revocation.revoked_at || null,
  };
}

// ---- attribution walk (registry-free) --------------------------------------

// Is instant `at` (ISO8601) inside [not_before, not_after)? A null not_after
// means "open-ended, until revoked". An unparseable timestamp is treated as
// out-of-window (fail closed).
function withinWindow(at, notBefore, notAfter) {
  const t = Date.parse(at);
  const lo = Date.parse(notBefore);
  if (Number.isNaN(t) || Number.isNaN(lo)) return false;
  if (t < lo) return false;
  if (notAfter == null) return true;
  const hi = Date.parse(notAfter);
  if (Number.isNaN(hi)) return false;
  return t < hi; // upper bound exclusive
}

/**
 * Resolve which root a leaf's signature at time `at` attributes to — the core
 * registry-free verify walk. Given the leaf did and the delegation/revocation
 * statements that travel alongside the work (embedded in / referenced by the
 * receipt, or carried on the a2a feed — never from a central store):
 *
 *   1. find a delegation whose leaf == this leaf, whose `sig` verifies by its
 *      declared root, whose window contains `at`, and that is not revoked;
 *   2. attribute to that root (via `role` if present).
 *
 * If NO valid delegation applies, the leaf is SELF-ANCHORED: root == leaf, the
 * degenerate single-key case — this is the hard backward-compat guarantee.
 *
 * @returns {{anchored:boolean, root:string, role:(string|null), reason?:string}}
 */
function resolveAnchor({ leaf, at, delegations = [], revocations = [] }) {
  if (!leaf) return { anchored: false, root: null, role: null, reason: "no leaf" };

  const candidates = [];
  for (const d of delegations) {
    if (!d || d.leaf !== leaf) continue;
    const vd = verifyDelegation(d);
    if (!vd.ok) continue;
    if (!withinWindow(at, vd.not_before, vd.not_after)) continue;
    candidates.push(vd);
  }

  for (const d of candidates) {
    // Revoked if a valid revocation from the SAME root for this leaf has
    // revoked_at <= the receipt time. A revocation dated after `at` doesn't
    // retroactively void work signed while the delegation was live.
    const revoked = revocations.some((r) => {
      if (!r || r.leaf !== leaf || r.root !== d.root) return false;
      const vr = verifyRevocation(r);
      if (!vr.ok) return false;
      const rt = Date.parse(r.revoked_at);
      const t = Date.parse(at);
      return !Number.isNaN(rt) && !Number.isNaN(t) && rt <= t;
    });
    if (revoked) continue;
    return { anchored: true, root: d.root, role: d.role };
  }

  // No delegation applies → self-anchored (leaf == root). Today's behaviour.
  return { anchored: false, root: leaf, role: null };
}

/**
 * Delegation-aware attribution for a co-signed receipt (lib/receipts.js). First
 * runs the ordinary receipt verify (leaf signatures unchanged from today), then
 * resolves each named party's leaf to a root at the receipt's timestamp.
 *
 * Returns { ok, reason?, attribution: { [leafDid]: {root, role, anchored} } }.
 * A receipt with no matching delegations attributes every party to itself —
 * identical to not calling this at all, so it's safe to run over any receipt.
 *
 * @param cosigned  { receipt, sigs } as produced by receipts.cosign
 * @param opts.delegations  delegation statements carried alongside the work
 * @param opts.revocations  revocation statements carried alongside the work
 * @param opts.verify       the receipts.verify function (injected to avoid a
 *                          require cycle); defaults to lib/receipts' verify.
 */
function verifyReceiptAttribution(cosigned, { delegations = [], revocations = [], verify, requireBoth = true } = {}) {
  const rcVerify = verify || require("./receipts").verify;
  const base = rcVerify(cosigned, { requireBoth });
  if (!base.ok) return { ok: false, reason: base.reason, attribution: {} };

  const at = cosigned.receipt.at;
  const attribution = {};
  for (const did of base.signers) {
    attribution[did] = resolveAnchor({ leaf: did, at, delegations, revocations });
  }
  return { ok: true, signers: base.signers, attribution };
}

module.exports = {
  DELEGATION_TYP,
  REVOCATION_TYP,
  canonicalStatementBytes,
  buildDelegation,
  buildRevocation,
  verifyDelegation,
  verifyRevocation,
  resolveAnchor,
  verifyReceiptAttribution,
  withinWindow,
};
