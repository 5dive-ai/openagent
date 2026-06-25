"use strict";

// Deterministic rarity ladder for OpenAgent personas.
//
// Tiers 1-4 (Common..Legendary) are a PURE FUNCTION of the persona file
// (plus whether face.ref actually resolves to an image). Mythical is
// CONFERRED: it requires Legendary AND the id being present in the official
// character-packs registry manifest — not farmable from the file alone.

const { TIER_TOKENS } = require("./tokens");
const crypto = require("crypto");
// did:key derivation lives in provenance; import in a try so tier.js still
// loads if provenance is ever absent (it degrades to "no identity" → Ungraded).
let didKeyFromPublicKey;
try { ({ didKeyFromPublicKey } = require("./provenance")); } catch (_) { didKeyFromPublicKey = null; }

const TIER_NAMES = ["Ungraded", "Common", "Rare", "Epic", "Legendary", "Mythical"];

// Per-tier display tokens, derived from the canonical ramp in tokens.js so
// there is exactly one palette across the card renderer and the gallery.
const TIER_STYLE = Object.fromEntries(
  TIER_NAMES.map((name) => {
    const t = TIER_TOKENS[name.toLowerCase()];
    return [name, { color: t.accent, accent2: t.accent2, bgDeep: t.bgDeep, foil: t.holo ? "holo" : t.foil ? "subtle" : "none" }];
  })
);

const str = (s) => (typeof s === "string" ? s.trim() : "");
const present = (s) => str(s).length > 0;

function isStubSample(s) {
  const t = str(s);
  if (t.length < 12) return true;
  return /^(todo|tbd|tba|unset|sample|placeholder|n\/?a|xxx|\.\.\.|lorem)\b/i.test(t);
}

function isNamedVoice(base) {
  const t = str(base).toLowerCase();
  return t.length > 0 && t !== "unset";
}

function nonEmptyObj(o) {
  return o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length > 0;
}
function nonEmptyArr(a) {
  return Array.isArray(a) && a.length > 0;
}

// Structural proxy for "schema-valid" — the subset of the v0.1 schema the gate
// ladder leans on. Used only when the caller can't hand us an authoritative
// schema verdict via ctx.schemaValid.
function looksSchemaValid(p, audio, written) {
  return (
    present(p.id) && present(p.name) && present(p.role) &&
    present(p.behavior) && nonEmptyObj(p.face) &&
    present(audio.base) && present(written.sample) && nonEmptyArr(written.rules)
  );
}

/**
 * @param {object} persona  parsed persona document
 * @param {object} ctx      { faceResolved?: boolean, inRegistry?: boolean,
 *                            schemaValid?: boolean }
 *   schemaValid: authoritative verdict from the v0.1 JSON Schema validator.
 *   When supplied it DEFINES the Common rung (spec: "Common: schema-valid").
 *   When omitted, a structural proxy stands in so the function stays usable
 *   standalone (e.g. quick gallery previews).
 * @returns {{ tier: string, level: number, completeness: number,
 *            gates: object, style: object }}
 */
// ── Identity-seeded rarity roll (v0.2) ────────────────────────────────
// Odds for the rolled base tiers. Mythical is CONFERRED (curated registry),
// never rolled, so it is not in this table. Must sum to 1.
// Curve v2 (2026-06-25): rebalanced so Common is no longer the default majority —
// most identities now land Rare+ and the top end is more attainable. This is a
// one-time recalibration: because the roll is a pure function of did:key, the new
// curve re-rolls existing identities (a card minted under the old 60/25/11/4 may
// shift tier on its next render). Monotonic: each tier rarer than the one below.
// The 5dive founding cast is held at its pre-cutover tier via TIER_PINS below.
const ROLL_ODDS = [
  ["Common", 0.4],
  ["Rare", 0.3],
  ["Epic", 0.2],
  ["Legendary", 0.1],
];

// Deterministic uniform in [0,1) from a stable seed string (sha256 → 48 bits).
function seededUnit(seed) {
  const h = crypto.createHash("sha256").update(String(seed)).digest();
  let n = 0;
  for (let i = 0; i < 6; i++) n = n * 256 + h[i]; // top 48 bits
  return n / 0x1000000000000; // 2^48
}

// Map a seed to a base tier by the cumulative ROLL_ODDS.
function rollTier(seed) {
  const u = seededUnit(seed);
  let acc = 0;
  for (const [name, prob] of ROLL_ODDS) {
    acc += prob;
    if (u < acc) return name;
  }
  return ROLL_ODDS[ROLL_ODDS.length - 1][0]; // float-rounding safety
}

// Founding-cast rarity pins (curve v2 cutover, 2026-06-25). The 5dive team rolled
// their tiers under curve v1 (60/25/11/4); the v2 recalibration would re-roll
// them, so each founding identity is held at the tier it had at cutover. Keyed by
// the IMMUTABLE did:key (not the farmable `id`). A pin overrides the roll but NOT
// conferral — an inRegistry identity is still Mythical. Everyone else rolls. This
// map is deliberately tiny and closed: it is not a general grant mechanism.
const TIER_PINS = {
  "did:key:z6MkfxJdF5PhqHcgpKNy9vY6Y9MAzZJ9EqqVywXqFJUa8VaG": "Legendary", // marcus
  "did:key:z6MkmCyZtZkk37mb46ekUGKkW5zLBU94u1ZPS5BTU9FfqQfE": "Legendary", // olivia
  "did:key:z6MkqKc8VDUidM6VXoxeURDAdC6EEH2Mi4SqkB8NRpkXhbJL": "Epic",      // lilbro
  "did:key:z6Mkw1KjXTrwEMRqMYhNJobvboNFMM9AQUt1ZNudxV45vsjK": "Epic",      // theo
  "did:key:z6Mkey1FXu4tk4UMxDEbosfD2Gqx6u7qj3EP2atsEuAkSRwL": "Rare",      // dario
  "did:key:z6Mki47TZEj3KTmVW2naTPU1FzqwxhN74Qq5CttQxYLehHUh": "Common",    // dude
};

// The immutable identity seed: the persona's did:key. Prefer an authoritative
// did handed in via ctx.didKey; else derive it from the ed25519 public key in
// provenance.created_by.key. Returns null when there is NO identity (an
// unsigned persona) — which stays Ungraded so the roll can't be farmed by
// editing an unsigned file. Note: the user-chosen `id` is deliberately NOT a
// seed input (it would be farmable by renaming).
function identitySeed(persona, ctx = {}) {
  if (ctx.didKey) return String(ctx.didKey);
  const key = (((persona || {}).provenance || {}).created_by || {}).key;
  if (key && didKeyFromPublicKey) {
    try {
      return didKeyFromPublicKey(key);
    } catch (_) {
      return null;
    }
  }
  return null;
}

function computeTier(persona, ctx = {}) {
  const p = persona || {};
  const face = p.face || {};
  const audio = (p.voice && p.voice.audio) || {};
  const written = (p.voice && p.voice.written) || {};
  const faceResolved = !!ctx.faceResolved;
  const inRegistry = !!ctx.inRegistry;
  const schemaValid =
    ctx.schemaValid != null ? !!ctx.schemaValid : looksSchemaValid(p, audio, written);

  // Rarity is NOT earned by how complete the file is. Base tiers
  // (Common..Legendary) are a deterministic RANDOM roll seeded by the persona's
  // immutable did:key — one identity, one rarity, fixed forever, unfarmable
  // (the only way to a different roll is to mint a whole new identity). Mythical
  // is never rolled; it is CONFERRED by acceptance into the curated, signed
  // character-packs registry. Entry rule: to be graded you must be schema-valid
  // AND have an identity key; otherwise Ungraded. Completeness + badges (below)
  // are a SEPARATE effort axis and never move your tier.
  const seed = identitySeed(p, ctx);
  const graded = schemaValid && !!seed;

  let tier;
  if (inRegistry) tier = "Mythical"; // conferred (curated + cryptographically signed)
  else if (!graded) tier = "Ungraded"; // no identity, or not schema-valid
  else if (TIER_PINS[seed]) tier = TIER_PINS[seed]; // founding-cast pin (curve v2 cutover)
  else tier = rollTier(seed); // identity-seeded random Common..Legendary

  const level = TIER_NAMES.indexOf(tier); // Ungraded=0 … Mythical=5

  // Gates re-expressed for the v0.2 model (kept on the result for consumers).
  const gates = {
    graded, // schema-valid AND has an identity key → eligible for a roll
    schemaValid,
    signed: !!seed, // has a cryptographic identity (did:key)
    mythical: inRegistry, // conferred via the curated registry
  };

  // Completeness: fraction of the "fully specified" surface that is present.
  const checklist = [
    present(p.id),
    present(p.name),
    present(p.role),
    present(p.behavior),
    present(face.ref),
    present(face.anchor),
    present(face.full),
    present(face.sprite),
    isNamedVoice(audio.base),
    present(audio.style),
    present(audio.ref),
    present(audio.id),
    nonEmptyArr(written.rules),
    !isStubSample(written.sample),
    nonEmptyArr(p.posts_about),
    nonEmptyObj(p.links),
  ];
  const completeness = Math.round(
    (checklist.filter(Boolean).length / checklist.length) * 100
  );

  return { tier, level, completeness, gates, style: TIER_STYLE[tier] };
}

// ── Collectible badges ──────────────────────────────────────────────
// Badges are ORTHOGONAL to the rarity ladder: a persona can earn any of them
// at any tier. The ladder hard-stops at the first unmet gate, so a genuinely
// valuable asset (a fully cloned voice, a sprite sheet) stays invisible when
// it sits behind an earlier unmet rung — e.g. a voice-cloned persona stuck at
// Common because its written.sample is still a stub. Badges surface those
// assets directly, turning completeness from one opaque number into a
// checklist of collectibles you can chase independently.
//
// Each entry's `earned(persona, ctx)` is a pure predicate over the file
// (ctx only carries an authoritative `signatureValid` verdict when a caller
// has actually verified the signature; otherwise presence stands in).
const BADGE_CATALOG = [
  { key: "voice-clone", label: "Voice Clone",
    desc: "a reference clip the voice is cloned from (voice.audio.ref)",
    earned: (p) => present(((p.voice || {}).audio || {}).ref) },
  { key: "sprite-sheet", label: "Sprite Sheet",
    desc: "an expression/pose sprite sheet for reels (face.sprite)",
    earned: (p) => present((p.face || {}).sprite) },
  { key: "full-body", label: "Full Body",
    desc: "a full-body reference render (face.full)",
    earned: (p) => present((p.face || {}).full) },
  { key: "face-recipe", label: "Regenerable Face",
    desc: "a recipe (model+prompt+seed) that re-renders the likeness on-model (face.recipe)",
    earned: (p) => nonEmptyObj((p.face || {}).recipe) },
  { key: "signed", label: "Signed",
    desc: "an ed25519 authorship signature (provenance.signature)",
    earned: (p, ctx) =>
      ctx.signatureValid != null ? !!ctx.signatureValid : present((p.provenance || {}).signature) },
  { key: "remixed", label: "Remix Lineage",
    desc: "declared derived-from lineage to a parent persona (provenance.derived_from)",
    earned: (p) => nonEmptyArr((p.provenance || {}).derived_from) },
];

const BADGE_KEYS = BADGE_CATALOG.map((b) => b.key);

/** Earned badges for a persona, orthogonal to its tier. */
function computeBadges(persona, ctx = {}) {
  const p = persona || {};
  return BADGE_CATALOG
    .filter((b) => b.earned(p, ctx))
    .map((b) => ({ key: b.key, label: b.label, desc: b.desc }));
}

// ── Progression hints (v0.2) ────────────────────────────────────────
// Rarity is fixed by identity, so there is no rung to "fill in" for the base
// tiers. The only progression is: get GRADED (validate + sign), then be
// conferred MYTHICAL (curated registry). Completeness + badges are the parallel
// chase. rungNeeds() returns these as a keyed object for any consumer.
const PROGRESSION = {
  ungraded:
    "render your card (it auto-mints your identity) or run `openagent sign` — that stamps your did:key and rolls your permanent rarity",
  graded:
    "get accepted into the curated character-packs registry (raise completeness + collect badges meanwhile)",
  mythical: "Mythical — top of the ladder, conferred by the signed registry",
};

function rungNeeds() {
  return PROGRESSION;
}

/**
 * The single next goal, given a computed tier result. Unlike v0.1 this is not a
 * rung to fill — base rarity is fixed by identity — so it points at getting
 * graded (if Ungraded) or at Mythical (the only conferred climb).
 * @returns {{ goal: string, label: string, need: string } | null}
 *          null when already Mythical.
 */
function nextRung(t) {
  if (!t || t.tier === "Mythical") return null;
  if (t.tier === "Ungraded") return { goal: "graded", label: "Graded", need: PROGRESSION.ungraded };
  return { goal: "mythical", label: "Mythical", need: PROGRESSION.graded };
}

module.exports = {
  computeTier, computeBadges, nextRung, rungNeeds,
  BADGE_CATALOG, BADGE_KEYS,
  TIER_NAMES, TIER_STYLE, isStubSample, isNamedVoice,
};
