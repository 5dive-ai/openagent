"use strict";

// Deterministic rarity ladder for OpenAgent personas.
//
// Tiers 1-4 (Common..Legendary) are a PURE FUNCTION of the persona file
// (plus whether face.ref actually resolves to an image). Mythical is
// CONFERRED: it requires Legendary AND the id being present in the official
// character-packs registry manifest — not farmable from the file alone.

const TIER_NAMES = ["Ungraded", "Common", "Rare", "Epic", "Legendary", "Mythical"];

// Per-tier display tokens the renderer / frame treatment can key off.
// (Lil bro owns the frame/foil visuals; these are the defaults + accent hints.)
const TIER_STYLE = {
  Ungraded: { color: "#6b7280", foil: "none" },
  Common: { color: "#9aa3b2", foil: "none" },
  Rare: { color: "#4aa3ff", foil: "none" },
  Epic: { color: "#a855f7", foil: "none" },
  Legendary: { color: "#f0b429", foil: "subtle" },
  Mythical: { color: "#ff4dd2", foil: "holo" },
};

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

/**
 * @param {object} persona  parsed persona document
 * @param {object} ctx      { faceResolved?: boolean, inRegistry?: boolean }
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

  const gates = {
    common:
      present(p.id) && present(p.name) && present(p.role) &&
      present(audio.base) && present(written.sample),
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

module.exports = { computeTier, TIER_NAMES, TIER_STYLE, isStubSample, isNamedVoice };
