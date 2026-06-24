"use strict";

// Deterministic rarity ladder for OpenAgent personas.
//
// Tiers 1-4 (Common..Legendary) are a PURE FUNCTION of the persona file
// (plus whether face.ref actually resolves to an image). Mythical is
// CONFERRED: it requires Legendary AND the id being present in the official
// character-packs registry manifest — not farmable from the file alone.

const { TIER_TOKENS } = require("./tokens");

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
function computeTier(persona, ctx = {}) {
  const p = persona || {};
  const face = p.face || {};
  const audio = (p.voice && p.voice.audio) || {};
  const written = (p.voice && p.voice.written) || {};
  const faceResolved = !!ctx.faceResolved;
  const inRegistry = !!ctx.inRegistry;
  const schemaValid =
    ctx.schemaValid != null ? !!ctx.schemaValid : looksSchemaValid(p, audio, written);

  const gates = {
    common: schemaValid,
    rare: faceResolved && !isStubSample(written.sample),
    epic: isNamedVoice(audio.base) && present(p.behavior),
    legendary:
      present(audio.style) &&
      present(face.anchor) &&
      present(face.sprite) &&
      nonEmptyObj(p.links) &&
      nonEmptyArr(p.posts_about),
    mythical: inRegistry,
  };

  // Climb the ladder while each rung passes; stop at the first failure.
  const ladder = ["common", "rare", "epic", "legendary", "mythical"];
  let level = 0;
  for (const rung of ladder) {
    if (gates[rung]) level += 1;
    else break;
  }
  const tier = TIER_NAMES[level];

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

// ── Next-rung hints ─────────────────────────────────────────────────
// One human-readable line per rung naming exactly what to add to reach it.
// faceResolved flips the Rare hint between "resolve the face" and "fix the
// sample", since those are the two ways Rare can be blocked.
const RUNG_ORDER = ["common", "rare", "epic", "legendary", "mythical"];

function rungNeeds(faceResolved) {
  return {
    common: "id, name, role, voice.audio.base, written.sample",
    rare: faceResolved
      ? "a non-stub written.sample (≥12 real chars, no TODO/placeholder)"
      : "face.ref must resolve to a real image",
    epic: "a named voice base (voice.audio.base, not 'unset') + behavior",
    legendary: "voice.audio.style + face.anchor + face.sprite + non-empty links + posts_about",
    mythical: "listed in the signed character-packs registry (conferred, not self-set)",
  };
}

/**
 * The single rung to chase next, given a computed tier result.
 * @returns {{ rung: string, label: string, need: string } | null}
 *          null when already Mythical (top of the ladder).
 */
function nextRung(t, faceResolved) {
  if (!t || t.level >= RUNG_ORDER.length) return null;
  const rung = RUNG_ORDER[t.level]; // level = rungs passed → RUNG_ORDER[level] is first unmet
  return { rung, label: TIER_NAMES[t.level + 1], need: rungNeeds(faceResolved)[rung] };
}

module.exports = {
  computeTier, computeBadges, nextRung, rungNeeds,
  BADGE_CATALOG, BADGE_KEYS,
  TIER_NAMES, TIER_STYLE, isStubSample, isNamedVoice,
};
