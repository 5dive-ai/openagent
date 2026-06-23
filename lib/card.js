"use strict";

const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const { Resvg } = require("@resvg/resvg-js");

const FONT_DIR = path.join(__dirname, "..", "assets", "fonts");

// ---------- small deterministic helpers ----------

// FNV-1a -> 32-bit unsigned. Used to seed everything from persona text,
// so the same persona always renders the identical card.
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// On-brand accent palette; pick one deterministically per persona.
const ACCENTS = ["#5b8def", "#8b5cf6", "#22c1a6", "#f59e0b", "#ec4899", "#ef4444"];

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (ch) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;",
  }[ch]));
}

// Rough word-wrap for SVG <text>. Inter avg glyph ~0.52em; good enough for layout.
function wrap(text, maxWidth, fontSize, maxLines) {
  const charW = fontSize * 0.52;
  const perLine = Math.max(1, Math.floor(maxWidth / charW));
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const candidate = cur ? cur + " " + w : w;
    if (candidate.length > perLine && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = candidate;
    }
  }
  if (cur) lines.push(cur);
  if (maxLines && lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/.{1}$/, "") + "…";
    return kept;
  }
  return lines;
}

function mimeFor(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return null;
}

// Returns a data: URI for a local face.ref, or null if not embeddable
// (URL, missing file, or unknown type — caller draws a fallback).
function faceDataUri(ref, baseDir) {
  if (!ref || /^https?:\/\//i.test(ref)) return null;
  const mime = mimeFor(ref);
  if (!mime) return null;
  // A relative face.ref may be written relative to the persona file OR to the
  // dir the command is run from (the examples do the latter). Try both.
  const candidates = path.isAbsolute(ref)
    ? [ref]
    : [path.resolve(baseDir, ref), path.resolve(process.cwd(), ref)];
  for (const abs of candidates) {
    try {
      const buf = fs.readFileSync(abs);
      return `data:${mime};base64,${buf.toString("base64")}`;
    } catch (_) {
      /* try next */
    }
  }
  return null;
}

// ---------- card SVG ----------

function buildSvg(persona, baseDir) {
  const W = 900;
  const H = 1260;
  const P = 48;
  const innerW = W - 2 * P;

  const seed = hash32((persona.id || "") + (persona.name || ""));
  const accent = ACCENTS[seed % ACCENTS.length];
  const rng = mulberry32(hash32((persona.voice?.audio?.base || "") + "|" + (persona.voice?.audio?.style || "") + "|" + (persona.id || "")));

  const name = persona.name || persona.id || "Unknown";
  const role = persona.role || "";
  const behavior = persona.behavior || "";
  const audio = persona.voice?.audio;
  const written = persona.voice?.written;

  // --- avatar ---
  const avX = P, avY = P, avW = innerW, avH = 560, avR = 28;
  const data = faceDataUri(persona.face?.ref, baseDir);
  let avatar;
  if (data) {
    // cover-fit a square source into the panel
    const side = Math.max(avW, avH);
    const ix = avX + (avW - side) / 2;
    const iy = avY + (avH - side) / 2;
    avatar = `<image href="${data}" x="${ix}" y="${iy}" width="${side}" height="${side}" preserveAspectRatio="xMidYMid slice" clip-path="url(#avClip)"/>`;
  } else {
    const initials = escapeXml(name.split(/\s+/).map((w) => w[0] || "").join("").slice(0, 2).toUpperCase());
    avatar =
      `<rect x="${avX}" y="${avY}" width="${avW}" height="${avH}" rx="${avR}" fill="#1b1f2a"/>` +
      `<text x="${avX + avW / 2}" y="${avY + avH / 2}" font-family="Inter" font-weight="700" font-size="160" fill="${accent}" text-anchor="middle" dominant-baseline="central">${initials}</text>`;
  }

  // role chip, bottom-left of the avatar
  const chip = role
    ? `<g>
         <rect x="${avX + 20}" y="${avY + avH - 64}" width="${Math.min(innerW - 40, 28 + role.length * 13)}" height="44" rx="22" fill="rgba(8,10,16,0.72)"/>
         <text x="${avX + 42}" y="${avY + avH - 34}" font-family="Inter" font-weight="700" font-size="22" fill="#fff" letter-spacing="0.5">${escapeXml(role)}</text>
       </g>`
    : "";

  // --- text block ---
  let y = avY + avH + 76;
  const nameSvg = `<text x="${P}" y="${y}" font-family="Inter" font-weight="700" font-size="68" fill="#fff">${escapeXml(name)}</text>`;
  y += 18;

  // behavior (one line of character), wrapped
  const behLines = wrap(behavior, innerW, 27, 3);
  y += 40;
  let behSvg = "";
  for (const ln of behLines) {
    behSvg += `<text x="${P}" y="${y}" font-family="Inter" font-weight="400" font-size="27" fill="#aab2c5">${escapeXml(ln)}</text>`;
    y += 38;
  }

  // --- voice section ---
  y += 24;
  const voiceLabel = `<text x="${P}" y="${y}" font-family="Inter" font-weight="700" font-size="18" fill="${accent}" letter-spacing="2">VOICE</text>`;
  y += 16;

  // waveform
  const wfX = P, wfW = innerW, wfTop = y, wfH = 86;
  const bars = 56;
  const gap = 5;
  const bw = (wfW - gap * (bars - 1)) / bars;
  let wf = "";
  for (let i = 0; i < bars; i++) {
    const amp = 0.18 + rng() * 0.82;
    const bh = Math.max(4, amp * wfH);
    const bx = wfX + i * (bw + gap);
    const by = wfTop + (wfH - bh) / 2;
    wf += `<rect x="${bx.toFixed(2)}" y="${by.toFixed(2)}" width="${bw.toFixed(2)}" height="${bh.toFixed(2)}" rx="${(bw / 2).toFixed(2)}" fill="url(#wfGrad)"/>`;
  }
  y = wfTop + wfH + 40;

  // voice descriptors: base · style
  let voiceMeta = "";
  if (audio) {
    const base = audio.base ? `base ${audio.base}` : "";
    const styleLines = wrap(audio.style || "", innerW, 24, 2);
    if (base) {
      voiceMeta += `<text x="${P}" y="${y}" font-family="Inter" font-weight="700" font-size="24" fill="#e6e9f2">${escapeXml(base)}</text>`;
      y += 36;
    }
    for (const ln of styleLines) {
      voiceMeta += `<text x="${P}" y="${y}" font-family="Inter" font-weight="400" font-size="24" fill="#8b93a7">${escapeXml(ln)}</text>`;
      y += 33;
    }
  }

  // written sample, as a quote
  let sampleSvg = "";
  if (written?.sample) {
    y += 18;
    const qLines = wrap(`“${written.sample}”`, innerW - 24, 25, 3);
    sampleSvg += `<rect x="${P}" y="${y - 28}" width="6" height="${qLines.length * 34 + 4}" rx="3" fill="${accent}"/>`;
    for (const ln of qLines) {
      sampleSvg += `<text x="${P + 22}" y="${y}" font-family="Inter" font-weight="400" font-size="25" font-style="italic" fill="#c7ccdb">${escapeXml(ln)}</text>`;
      y += 34;
    }
  }

  // footer
  const footY = H - 40;
  const footer =
    `<text x="${P}" y="${footY}" font-family="Inter" font-weight="700" font-size="20" fill="#5a627a">OpenAgent</text>` +
    `<text x="${W - P}" y="${footY}" font-family="Inter" font-weight="400" font-size="20" fill="#5a627a" text-anchor="end">${escapeXml(persona.id || "")} · v${persona.openagent || "0.1"}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#11141d"/>
      <stop offset="1" stop-color="#0a0c12"/>
    </linearGradient>
    <linearGradient id="wfGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${accent}"/>
      <stop offset="1" stop-color="#6ee7d8"/>
    </linearGradient>
    <clipPath id="avClip"><rect x="${avX}" y="${avY}" width="${avW}" height="${avH}" rx="${avR}"/></clipPath>
  </defs>
  <rect x="0" y="0" width="${W}" height="${H}" rx="40" fill="url(#bg)"/>
  <rect x="6" y="6" width="${W - 12}" height="${H - 12}" rx="36" fill="none" stroke="${accent}" stroke-opacity="0.5" stroke-width="2"/>
  ${avatar}
  <rect x="${avX}" y="${avY}" width="${avW}" height="${avH}" rx="${avR}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  ${chip}
  ${nameSvg}
  ${behSvg}
  ${voiceLabel}
  ${wf}
  ${voiceMeta}
  ${sampleSvg}
  ${footer}
</svg>`;
}

function loadFonts() {
  const files = ["Inter-Regular.otf", "Inter-Bold.otf"];
  const buffers = [];
  for (const f of files) {
    try {
      buffers.push(fs.readFileSync(path.join(FONT_DIR, f)));
    } catch (_) {}
  }
  return buffers;
}

/**
 * Render a persona file to a PNG trading card.
 * @returns {{ ok: boolean, outPath?: string, width?: number, height?: number, error?: string }}
 */
function renderCard(file, outPath) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { ok: false, error: `cannot read file: ${e.message}` };
  }
  let persona;
  try {
    persona = YAML.parse(raw);
  } catch (e) {
    return { ok: false, error: `not valid YAML/JSON: ${e.message}` };
  }
  if (!persona || typeof persona !== "object") {
    return { ok: false, error: "persona is empty or not an object" };
  }

  const baseDir = path.dirname(path.resolve(file));
  const svg = buildSvg(persona, baseDir);

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
  try {
    fs.writeFileSync(out, pngBuf);
  } catch (e) {
    return { ok: false, error: `cannot write ${out}: ${e.message}` };
  }
  return { ok: true, outPath: out, width: 900, height: 1260, bytes: pngBuf.length };
}

module.exports = { renderCard, buildSvg };
