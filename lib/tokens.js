"use strict";

// Canonical OpenAgent rarity tier → design tokens.
// Single source of truth for BOTH the card renderer (lib/card.js) and the
// gallery (DIVE-636). Locked v3 palette from creative (Lil bro) 2026-06-23 —
// colors are final; only the label font is still in flux upstream.
//
//   accent  = primary (frame / glow / badge / waveform / labels)
//   accent2 = gradient partner (waveform end, foil-stroke end)
//   bgDeep  = tier-tinted backdrop base (v3 cutout mode)
//   glowN   = stacked-stroke glow count   foil/holo = frame treatment

const TIER_TOKENS = {
  ungraded:  { label: "UNGRADED",  accent: "#7C8597", accent2: "#5A6273", bgDeep: "#101319", glowN: 0, foil: false, holo: false, gem: "#7C8597" },
  common:    { label: "COMMON",    accent: "#4BD489", accent2: "#1F8F55", bgDeep: "#0a1a12", glowN: 0, foil: false, holo: false, gem: "#4BD489" },
  rare:      { label: "RARE",      accent: "#56A0FF", accent2: "#2A5FD0", bgDeep: "#0a1322", glowN: 2, foil: false, holo: false, gem: "#56A0FF" },
  epic:      { label: "EPIC",      accent: "#B57DFF", accent2: "#6E3BD6", bgDeep: "#150c24", glowN: 3, foil: true,  holo: false, gem: "#B57DFF" },
  legendary: { label: "LEGENDARY", accent: "#FFC53D", accent2: "#D8881A", bgDeep: "#1e1505", glowN: 4, foil: true,  holo: false, gem: "#FFC53D" },
  mythical:  { label: "MYTHICAL",  accent: "#FF8AE0", accent2: "#7CE0FF", bgDeep: "#160a18", glowN: 5, foil: true,  holo: true,  gem: "#FFFFFF" },
};

// Mythical bezel + wash rainbow ramp.
const HOLO_STOPS = ["#FF6BD6", "#FFD36B", "#7CFFB2", "#6BD5FF", "#B07CFF", "#FF6BD6"];

// level (0-5) -> token key
function keyForLevel(level) {
  return ["ungraded", "common", "rare", "epic", "legendary", "mythical"][level] || "common";
}

module.exports = { TIER_TOKENS, HOLO_STOPS, keyForLevel };
