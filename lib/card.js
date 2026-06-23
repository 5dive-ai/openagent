"use strict";

const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const { Resvg } = require("@resvg/resvg-js");
const { computeTier, TIER_NAMES } = require("./tier");
const { TIER_TOKENS, keyForLevel } = require("./tokens");
const { validateFile } = require("./validate");

const FONT_DIR = path.join(__dirname, "..", "assets", "fonts");
const REGISTRY_URL =
  "https://raw.githubusercontent.com/5dive-ai/character-packs/main/index.json";

// The premium frame/foil/holo treatment below is Lil bro's (Creative) spec —
// see creative/openagent-card/FRAME-SPEC.md. Dev owns the tier LOGIC (tier.js)
// + the async face/registry resolution; the SVG is his.

// ---------- deterministic helpers ----------
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function esc(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
}
function wrap(text, maxW, fsz, maxLines) {
  const cw = fsz * 0.515;
  const per = Math.max(1, Math.floor(maxW / cw));
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const c = cur ? cur + " " + w : w;
    if (c.length > per && cur) { lines.push(cur); cur = w; } else cur = c;
  }
  if (cur) lines.push(cur);
  if (maxLines && lines.length > maxLines) {
    const k = lines.slice(0, maxLines);
    k[maxLines - 1] = k[maxLines - 1].replace(/.{1}$/, "") + "…";
    return k;
  }
  return lines;
}
function mimeForExt(p) {
  const ext = path.extname(p.split("?")[0]).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return null;
}

// ---------- async resolution (local file OR public URL) ----------

// Resolve face.ref to an embeddable data URI. Returns { dataUri, resolved }.
// Supports local relative/absolute paths AND http(s) URLs so a clean dir (or a
// remote/shared persona) renders the real avatar, not the monogram fallback.
async function resolveFace(ref, baseDir) {
  if (!ref) return { dataUri: null, resolved: false };

  if (/^https?:\/\//i.test(ref)) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(ref, { signal: ctrl.signal, redirect: "follow" });
      clearTimeout(t);
      if (!res.ok) return { dataUri: null, resolved: false };
      const ct = (res.headers.get("content-type") || "").split(";")[0].trim();
      const mime = ct && ct.startsWith("image/") ? ct : mimeForExt(ref);
      if (!mime) return { dataUri: null, resolved: false };
      const buf = Buffer.from(await res.arrayBuffer());
      return { dataUri: `data:${mime};base64,${buf.toString("base64")}`, resolved: true };
    } catch (_) {
      return { dataUri: null, resolved: false };
    }
  }

  const mime = mimeForExt(ref);
  if (!mime) return { dataUri: null, resolved: false };
  const candidates = path.isAbsolute(ref)
    ? [ref]
    : [path.resolve(baseDir, ref), path.resolve(process.cwd(), ref)];
  for (const abs of candidates) {
    try {
      const buf = fs.readFileSync(abs);
      return { dataUri: `data:${mime};base64,${buf.toString("base64")}`, resolved: true };
    } catch (_) { /* next */ }
  }
  return { dataUri: null, resolved: false };
}

// Best-effort: fetch the registry manifest, return a Set of pack slugs.
let _registryCache = null;
async function fetchRegistryIds() {
  if (_registryCache) return _registryCache;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(REGISTRY_URL, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return (_registryCache = new Set());
    const json = await res.json();
    const slugs = (json.packs || []).map((p) => p.slug).filter(Boolean);
    return (_registryCache = new Set(slugs));
  } catch (_) {
    return (_registryCache = new Set());
  }
}

// Tier themes live in ./tokens.js (canonical, shared with the gallery).
const TIERS = TIER_TOKENS;

// ---------- card SVG (Lil bro's frame treatment) ----------
function buildSvg(persona, faceDataUri, tierKey) {
  const W = 900, H = 1260, P = 48, innerW = W - 2 * P;
  const T = TIERS[tierKey] || TIERS.common;
  const A = T.accent;
  const rng = mulberry32(hash32((persona.voice?.audio?.base || "") + "|" + (persona.voice?.audio?.style || "") + "|" + (persona.id || "")));

  const name = persona.name || persona.id || "Unknown";
  const role = persona.role || "";
  const behavior = persona.behavior || "";
  const audio = persona.voice?.audio;
  const written = persona.voice?.written;

  const heroH = 688, R = 40;
  const side = Math.max(W, heroH);
  const ix = (W - side) / 2, iy = (heroH - side) / 2;
  const face = faceDataUri
    ? `<image href="${faceDataUri}" x="${ix}" y="${iy}" width="${side}" height="${side}" preserveAspectRatio="xMidYMid slice" clip-path="url(#heroClip)"/>`
    : `<rect width="${W}" height="${heroH}" fill="#15171F" clip-path="url(#heroClip)"/>
       <text x="${W / 2}" y="${heroH / 2}" font-family="Inter Display" font-weight="800" font-size="180" fill="${A}" fill-opacity="0.85" text-anchor="middle" dominant-baseline="central">${esc(name.split(/\s+/).map((w) => w[0] || "").join("").slice(0, 2).toUpperCase())}</text>`;

  let foilLayer = "", glow = "";
  for (let g = 0; g < T.glowN; g++) {
    const w = 3 + g * 3, op = (0.16 - g * 0.026).toFixed(3);
    glow += `<rect x="${5 - g}" y="${5 - g}" width="${W - 10 + 2 * g}" height="${H - 10 + 2 * g}" rx="${R - 1 + g}" fill="none" stroke="${A}" stroke-opacity="${op}" stroke-width="${w}"/>`;
  }
  if (T.foil) {
    foilLayer += `<g clip-path="url(#cardClip)">`;
    const bands = T.holo ? 3 : 2;
    for (let b = 0; b < bands; b++) {
      const cx = 150 + b * 340;
      foilLayer += `<rect x="${cx}" y="-200" width="${110 + b * 30}" height="${H + 400}" fill="url(#sheen)" transform="rotate(18 ${cx} ${H / 2})" opacity="${T.holo ? 0.2 : 0.13}"/>`;
    }
    let spk = "";
    for (let i = 0; i < (T.holo ? 160 : 90); i++) {
      const x = (rng() * W).toFixed(1), y = (rng() * H).toFixed(1), r = (rng() * 1.5 + 0.4).toFixed(2);
      const c = T.holo ? `hsl(${Math.floor(rng() * 360)},90%,72%)` : A;
      spk += `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}" fill-opacity="${(0.05 + rng() * 0.1).toFixed(3)}"/>`;
    }
    foilLayer += spk + `</g>`;
  }
  if (T.holo) {
    foilLayer = `<rect x="0" y="0" width="${W}" height="${H}" rx="${R}" fill="url(#holoWash)" opacity="0.16"/>` + foilLayer;
  }

  const bw = 52 + T.label.length * 12.5, bh = 42, bx = W - P - bw, by = 40;
  const badge = `
    <g>
      <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${bh / 2}" fill="rgba(8,9,14,0.62)" stroke="${A}" stroke-opacity="0.9" stroke-width="1.5"/>
      <path d="M ${bx + 24} ${by + 11} l 9 8 l -9 12 l -9 -12 z" fill="${T.gem}" ${T.holo ? "" : `fill-opacity="0.95"`}/>
      <text x="${bx + 44}" y="${by + bh / 2 + 5}" font-family="DejaVu Sans Mono" font-weight="bold" font-size="15" letter-spacing="1.5" fill="#fff">${esc(T.label)}</text>
    </g>`;

  const roleKicker = role
    ? `<text x="${P}" y="${heroH - 92}" font-family="DejaVu Sans Mono" font-weight="bold" font-size="18" letter-spacing="3" fill="${A}">${esc(role.toUpperCase())}</text>`
    : "";
  const nameSvg = `<text x="${P - 2}" y="${heroH - 30}" font-family="Inter Display" font-weight="800" font-size="76" letter-spacing="-1.5" fill="#fff">${esc(name)}</text>`;

  let y = heroH + 58;
  let body = "";
  for (const ln of wrap(behavior, innerW, 25, 2)) { body += `<text x="${P}" y="${y}" font-family="Inter" font-weight="400" font-size="25" fill="#9CA3B4">${esc(ln)}</text>`; y += 35; }

  y += 18;
  body += `<rect x="${P}" y="${y}" width="${innerW}" height="1" fill="#fff" fill-opacity="0.09"/>`;
  y += 40;

  body += `<text x="${P}" y="${y}" font-family="DejaVu Sans Mono" font-weight="bold" font-size="17" letter-spacing="3" fill="${A}">VOICEPRINT</text>`;
  if (audio?.base) {
    const chipW = 34 + `base · ${audio.base}`.length * 9.2;
    body += `<g>
      <rect x="${W - P - chipW}" y="${y - 22}" width="${chipW}" height="30" rx="15" fill="${A}" fill-opacity="0.13" stroke="${A}" stroke-opacity="0.5" stroke-width="1"/>
      <text x="${W - P - chipW / 2}" y="${y - 1}" font-family="DejaVu Sans Mono" font-size="15" fill="#E6E9F2" text-anchor="middle">base · ${esc(audio.base)}</text>
    </g>`;
  }
  y += 22;

  const wfTop = y, wfH = 92, wfMid = wfTop + wfH / 2, bars = 64, gap = 4;
  const bw2 = (innerW - gap * (bars - 1)) / bars;
  for (let i = 0; i < bars; i++) {
    const amp = 0.12 + Math.pow(rng(), 0.8) * 0.88;
    const bh2 = Math.max(5, amp * wfH);
    const bx2 = P + i * (bw2 + gap);
    body += `<rect x="${bx2.toFixed(2)}" y="${(wfMid - bh2 / 2).toFixed(2)}" width="${bw2.toFixed(2)}" height="${bh2.toFixed(2)}" rx="${(bw2 / 2).toFixed(2)}" fill="url(#wf)"/>`;
  }
  y = wfTop + wfH + 40;

  if (audio?.style) {
    for (const ln of wrap(audio.style, innerW, 23, 2)) { body += `<text x="${P}" y="${y}" font-family="Inter" font-weight="400" font-size="23" fill="#8A92A4">${esc(ln)}</text>`; y += 31; }
  }

  if (written?.sample) {
    y += 20;
    const qLines = wrap(written.sample, innerW - 30, 25, 2);
    body += `<rect x="${P}" y="${y - 26}" width="5" height="${qLines.length * 34}" rx="2.5" fill="${A}"/>`;
    let yy = y;
    for (const ln of qLines) { body += `<text x="${P + 24}" y="${yy}" font-family="Inter" font-style="italic" font-weight="400" font-size="25" fill="#CDD2DE">${esc(ln)}</text>`; yy += 34; }
  }

  const footY = H - 44;
  body += `<rect x="${P}" y="${footY - 30}" width="${innerW}" height="1" fill="#fff" fill-opacity="0.07"/>`;
  body += `<text x="${P}" y="${footY}" font-family="DejaVu Sans Mono" font-weight="bold" font-size="18" letter-spacing="1" fill="#6B7388">openagent</text>`;
  body += `<text x="${W - P}" y="${footY}" font-family="DejaVu Sans Mono" font-size="18" fill="#6B7388" text-anchor="end">${esc(persona.id || "")} · v${esc(persona.openagent || "0.1")}</text>`;

  const frameStroke = T.holo ? "url(#holoStroke)" : T.foil ? "url(#foilStroke)" : A;
  const frame = `
    <rect x="0" y="0" width="${W}" height="${H}" rx="${R}" fill="none" stroke="#000" stroke-opacity="0.5" stroke-width="1"/>
    <rect x="7" y="7" width="${W - 14}" height="${H - 14}" rx="${R - 4}" fill="none" stroke="${frameStroke}" stroke-width="${T.holo ? 3.5 : T.foil ? 3 : 2.5}" stroke-opacity="${T.foil ? 1 : 0.85}"/>
    <rect x="13" y="13" width="${W - 26}" height="${H - 26}" rx="${R - 9}" fill="none" stroke="#fff" stroke-opacity="0.05" stroke-width="1"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0E0F15"/><stop offset="1" stop-color="#070809"/></linearGradient>
    <radialGradient id="topGlow" cx="0.5" cy="0.18" r="0.7"><stop offset="0" stop-color="${A}" stop-opacity="0.18"/><stop offset="1" stop-color="${A}" stop-opacity="0"/></radialGradient>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#070809" stop-opacity="0"/>
      <stop offset="0.55" stop-color="#0A0B11" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#0A0B10" stop-opacity="0.99"/>
    </linearGradient>
    <linearGradient id="wf" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${T.accent2}"/><stop offset="1" stop-color="${A}"/></linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="foilStroke" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${A}"/><stop offset="0.5" stop-color="#fff"/><stop offset="1" stop-color="${T.accent2}"/></linearGradient>
    <linearGradient id="holoStroke" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FF6BD6"/><stop offset="0.2" stop-color="#FFD36B"/><stop offset="0.4" stop-color="#7CFFB2"/>
      <stop offset="0.6" stop-color="#6BD5FF"/><stop offset="0.8" stop-color="#B07CFF"/><stop offset="1" stop-color="#FF6BD6"/>
    </linearGradient>
    <linearGradient id="holoWash" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FF6BD6"/><stop offset="0.25" stop-color="#FFD36B"/><stop offset="0.5" stop-color="#7CFFB2"/>
      <stop offset="0.75" stop-color="#6BD5FF"/><stop offset="1" stop-color="#B07CFF"/>
    </linearGradient>
    <clipPath id="cardClip"><rect x="0" y="0" width="${W}" height="${H}" rx="${R}"/></clipPath>
    <clipPath id="heroClip"><path d="M0 ${R} Q0 0 ${R} 0 H ${W - R} Q ${W} 0 ${W} ${R} V ${heroH} H 0 Z"/></clipPath>
  </defs>

  <rect x="0" y="0" width="${W}" height="${H}" rx="${R}" fill="url(#bg)"/>
  <rect x="0" y="0" width="${W}" height="${H}" rx="${R}" fill="url(#topGlow)"/>
  ${face}
  <rect x="0" y="0" width="${W}" height="${heroH}" fill="url(#scrim)" clip-path="url(#heroClip)"/>
  ${foilLayer}
  ${roleKicker}
  ${nameSvg}
  ${badge}
  ${body}
  ${glow}
  ${frame}
</svg>`;
}

const FONT_FILES = [
  "Inter-Regular.otf",
  "Inter-Italic.otf",
  "Inter-Bold.otf",
  "InterDisplay-Bold.otf",
  "InterDisplay-ExtraBold.otf",
  "DejaVuSansMono.ttf",
  "DejaVuSansMono-Bold.ttf",
];
function loadFonts() {
  const buffers = [];
  for (const f of FONT_FILES) {
    try { buffers.push(fs.readFileSync(path.join(FONT_DIR, f))); } catch (_) {}
  }
  return buffers;
}

const levelToKey = keyForLevel;

/**
 * Render a persona file to a PNG trading card.
 * @returns {Promise<{ ok, outPath?, width?, height?, bytes?, tier?, level?, completeness?, faceResolved?, error? }>}
 */
async function renderCard(file, outPath, opts = {}) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) { return { ok: false, error: `cannot read file: ${e.message}` }; }
  let persona;
  try { persona = YAML.parse(raw); }
  catch (e) { return { ok: false, error: `not valid YAML/JSON: ${e.message}` }; }
  if (!persona || typeof persona !== "object") return { ok: false, error: "persona is empty or not an object" };

  const baseDir = path.dirname(path.resolve(file));
  const face = await resolveFace(persona.face?.ref, baseDir);

  let inRegistry = false;
  if (opts.checkRegistry !== false) {
    inRegistry = (await fetchRegistryIds()).has(persona.id);
  }

  const schemaValid = validateFile(file).ok;
  const tier = computeTier(persona, { faceResolved: face.resolved, inRegistry, schemaValid });
  const svg = buildSvg(persona, face.dataUri, levelToKey(tier.level));

  let pngBuf;
  try {
    const resvg = new Resvg(svg, {
      fitTo: { mode: "width", value: 900 },
      font: { fontBuffers: loadFonts(), loadSystemFonts: false, defaultFontFamily: "Inter" },
    });
    pngBuf = resvg.render().asPng();
  } catch (e) {
    return { ok: false, error: `render failed: ${e.message}` };
  }

  const out = outPath || `${persona.id || "persona"}.card.png`;
  try { fs.writeFileSync(out, pngBuf); }
  catch (e) { return { ok: false, error: `cannot write ${out}: ${e.message}` }; }

  return {
    ok: true, outPath: out, width: 900, height: 1260, bytes: pngBuf.length,
    tier: tier.tier, level: tier.level, completeness: tier.completeness, faceResolved: face.resolved,
  };
}

module.exports = { renderCard, buildSvg, resolveFace, fetchRegistryIds, levelToKey, TIERS };
