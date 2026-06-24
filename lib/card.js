"use strict";

const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const { Resvg } = require("@resvg/resvg-js");
const { computeTier, TIER_NAMES } = require("./tier");
const { TIER_TOKENS, keyForLevel } = require("./tokens");
const { validateFile } = require("./validate");
const { fetchRegistryIds } = require("./registry");
const { didKeyFromPublicKey, shortDidKey } = require("./provenance");

const FONT_DIR = path.join(__dirname, "..", "assets", "fonts");

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


// Tier themes live in ./tokens.js (canonical, shared with the gallery).
const TIERS = TIER_TOKENS;

// ---------- card SVG (Lil bro's frame treatment) ----------
// `motion` is optional and back-compat: when omitted the SVG is byte-identical
// to the static card. When present ({ phase: 0..1 }) the foil/holo treatment is
// advanced to that point in a seamless loop — the renderer rasterizes one SVG
// per phase and stitches them (DIVE-665, animated cards). Motion is tier-aware:
// it falls out of the tokens — Common (glowN 0, no foil) is still, Rare gets a
// subtle glow breath, Epic/Legendary a foil sweep, Mythical the full holo flow.
function buildSvg(persona, faceDataUri, tierKey, motion) {
  const W = 900, H = 1260, P = 48, innerW = W - 2 * P;
  const T = TIERS[tierKey] || TIERS.common;
  const A = T.accent;
  const anim = motion && typeof motion.phase === "number";
  const phase = anim ? ((motion.phase % 1) + 1) % 1 : 0; // wrapped 0..1
  const TAU = Math.PI * 2;
  const breath = anim ? 0.85 + 0.15 * Math.sin(TAU * phase) : 1; // subtle glow pulse
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
    const w = 3 + g * 3, op = ((0.16 - g * 0.026) * breath).toFixed(3);
    glow += `<rect x="${5 - g}" y="${5 - g}" width="${W - 10 + 2 * g}" height="${H - 10 + 2 * g}" rx="${R - 1 + g}" fill="none" stroke="${A}" stroke-opacity="${op}" stroke-width="${w}"/>`;
  }
  if (T.foil) {
    foilLayer += `<g clip-path="url(#cardClip)">`;
    const bands = T.holo ? 3 : 2;
    // Static: bands fixed at 150 + b*340. Animated: each band sweeps across the
    // full card width on a seamless wrap so the foil/holo shimmers in motion.
    const span = W + 360;
    for (let b = 0; b < bands; b++) {
      const cx = anim
        ? (-180 + (((b * (span / bands)) + phase * span) % span)).toFixed(1)
        : 150 + b * 340;
      foilLayer += `<rect x="${cx}" y="-200" width="${110 + b * 30}" height="${H + 400}" fill="url(#sheen)" transform="rotate(18 ${cx} ${H / 2})" opacity="${T.holo ? 0.2 : 0.13}"/>`;
    }
    // Sparkle positions stay seeded/identical across frames (rng re-seeded each
    // call in the same order); only the holo hue rotates with phase so the
    // rainbow speckle flows without the dots jittering.
    const hueShift = anim && T.holo ? phase * 360 : 0;
    let spk = "";
    for (let i = 0; i < (T.holo ? 160 : 90); i++) {
      const x = (rng() * W).toFixed(1), y = (rng() * H).toFixed(1), r = (rng() * 1.5 + 0.4).toFixed(2);
      const c = T.holo ? `hsl(${Math.floor((rng() * 360 + hueShift) % 360)},90%,72%)` : A;
      spk += `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}" fill-opacity="${(0.05 + rng() * 0.1).toFixed(3)}"/>`;
    }
    foilLayer += spk + `</g>`;
  }
  if (T.holo) {
    const washOp = anim ? (0.16 * breath).toFixed(3) : "0.16";
    foilLayer = `<rect x="0" y="0" width="${W}" height="${H}" rx="${R}" fill="url(#holoWash)" opacity="${washOp}"/>` + foilLayer;
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

  // Verifiable handle: the short tail of the agent's did:key public address,
  // derived from its signing key. Present only on signed personas; absent ones
  // render byte-identically to before. The full address comes from `verify`.
  let didShort = "";
  try {
    const k = persona.provenance && persona.provenance.created_by && persona.provenance.created_by.key;
    if (k) didShort = shortDidKey(didKeyFromPublicKey(k));
  } catch (_) {
    /* unusable key → no handle on the card */
  }

  const footY = H - 44;
  body += `<rect x="${P}" y="${footY - 30}" width="${innerW}" height="1" fill="#fff" fill-opacity="0.07"/>`;
  body += `<text x="${P}" y="${footY}" font-family="DejaVu Sans Mono" font-weight="bold" font-size="18" letter-spacing="1" fill="#6B7388">openagent</text>`;
  if (didShort) body += `<text x="${W / 2}" y="${footY}" font-family="DejaVu Sans Mono" font-size="15" fill="#6B7388" text-anchor="middle">${esc(didShort)}</text>`;
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

// ---------- animated card (DIVE-665) ----------

const { encodeApng } = require("./apng");
const { execFileSync, spawnSync } = require("child_process");
const os = require("os");

const ANIM_FORMATS = ["apng", "gif", "webp", "mp4"];

// ffmpeg is optional: APNG is encoded in-process (zero deps), but gif/webp/mp4
// shell out to the system ffmpeg. Cached so we probe at most once.
let _ffmpeg;
function hasFfmpeg() {
  if (_ffmpeg === undefined) {
    try { _ffmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0; }
    catch (_) { _ffmpeg = false; }
  }
  return _ffmpeg;
}

// Encode an array of PNG frame buffers to gif/webp/mp4 via ffmpeg.
function encodeWithFfmpeg(frames, format, fps, outPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-card-"));
  try {
    frames.forEach((buf, i) => fs.writeFileSync(path.join(dir, `f_${String(i).padStart(4, "0")}.png`), buf));
    const inPat = path.join(dir, "f_%04d.png");
    // Pass an explicit muxer (-f) so the output works regardless of the
    // extension the caller chose for -o.
    let args;
    if (format === "gif") {
      // single-pass palettegen→paletteuse for clean colors on the holo ramp
      args = ["-y", "-framerate", String(fps), "-i", inPat,
        "-vf", "split[s0][s1];[s0]palettegen=stats_mode=full[p];[s1][p]paletteuse=dither=sierra2_4a",
        "-loop", "0", "-f", "gif", outPath];
    } else if (format === "webp") {
      args = ["-y", "-framerate", String(fps), "-i", inPat,
        "-c:v", "libwebp", "-loop", "0", "-lossless", "0", "-q:v", "72", "-preset", "picture",
        "-f", "webp", outPath];
    } else { // mp4 — pad to even dims for yuv420p, loop-friendly short clip
      args = ["-y", "-framerate", String(fps), "-i", inPat,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-r", String(fps), "-f", "mp4", outPath];
    }
    execFileSync("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    return fs.statSync(outPath).size;
  } finally {
    try { for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f)); fs.rmdirSync(dir); } catch (_) {}
  }
}

/**
 * Render a persona to an ANIMATED trading card (DIVE-665). The foil/holo
 * treatment loops seamlessly; motion is tier-aware (Common still → Mythical full
 * holo). APNG is the dependency-free default; gif/webp/mp4 need system ffmpeg.
 * @returns {Promise<{ ok, outPath?, format?, frames?, fps?, width?, height?, bytes?, tier?, level?, completeness?, faceResolved?, sharperWithFfmpeg?, error? }>}
 */
async function renderAnimatedCard(file, outPath, opts = {}) {
  const format = (opts.format || "apng").toLowerCase();
  if (!ANIM_FORMATS.includes(format)) {
    return { ok: false, error: `unknown format '${format}' — use one of: ${ANIM_FORMATS.join(", ")}` };
  }
  if (format !== "apng" && !hasFfmpeg()) {
    return { ok: false, error: `${format} needs ffmpeg on PATH (not found). Use --format apng for a zero-dependency animated card.` };
  }

  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) { return { ok: false, error: `cannot read file: ${e.message}` }; }
  let persona;
  try { persona = YAML.parse(raw); }
  catch (e) { return { ok: false, error: `not valid YAML/JSON: ${e.message}` }; }
  if (!persona || typeof persona !== "object") return { ok: false, error: "persona is empty or not an object" };

  // APNG re-encodes every frame in full (no native inter-frame delta), so a
  // photographic avatar makes it inherently multi-MB — default it lighter
  // (smaller + fewer frames) so the zero-dep fallback stays shareable. The
  // ffmpeg formats compress across frames, so they default richer.
  const frames = Math.max(2, Math.min(120, opts.frames || (format === "apng" ? 18 : 24)));
  const fps = Math.max(1, Math.min(60, opts.fps || (format === "apng" ? 15 : 20)));
  const width = Math.max(160, Math.min(900, opts.width || (format === "apng" ? 480 : 720)));

  const baseDir = path.dirname(path.resolve(file));
  const face = await resolveFace(persona.face?.ref, baseDir);

  let inRegistry = false;
  if (opts.checkRegistry !== false) inRegistry = (await fetchRegistryIds()).has(persona.id);

  const schemaValid = validateFile(file).ok;
  const tier = computeTier(persona, { faceResolved: face.resolved, inRegistry, schemaValid });
  const key = levelToKey(tier.level);

  const h = Math.round((width / 900) * 1260);
  // resvg-js (2.6.2) ignores `fitTo` when a `font` block is also passed, so we
  // scale by rewriting the SVG root's width/height while keeping the 900×1260
  // viewBox — this both honors --width AND keeps APNG frames small (the avatar
  // photo is re-encoded per frame, so resolution drives file size).
  const fontBuffers = loadFonts();
  const pngFrames = [];
  for (let f = 0; f < frames; f++) {
    let svg = buildSvg(persona, face.dataUri, key, { phase: f / frames });
    if (width !== 900) svg = svg.replace('width="900" height="1260"', `width="${width}" height="${h}"`);
    try {
      const resvg = new Resvg(svg, {
        font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: "Inter" },
      });
      pngFrames.push(resvg.render().asPng());
    } catch (e) {
      return { ok: false, error: `render failed on frame ${f}: ${e.message}` };
    }
  }

  const ext = format === "apng" ? "apng" : format;
  const out = outPath || `${persona.id || "persona"}.card.${ext}`;
  let bytes;
  try {
    if (format === "apng") {
      const apng = encodeApng(pngFrames, { delayNum: 1, delayDen: fps, plays: 0 });
      fs.writeFileSync(out, apng);
      bytes = apng.length;
    } else {
      bytes = encodeWithFfmpeg(pngFrames, format, fps, out);
    }
  } catch (e) {
    return { ok: false, error: `encode failed: ${e.message}` };
  }

  return {
    ok: true, outPath: out, format, frames, fps, width, height: h, bytes,
    tier: tier.tier, level: tier.level, completeness: tier.completeness, faceResolved: face.resolved,
    // hint the CLI uses to steer socials toward mp4 (best inline-play compat)
    sharperWithFfmpeg: format === "apng" && hasFfmpeg(),
  };
}

// fetchRegistryIds is re-exported for back-compat with existing callers
// (e.g. bin/openagent.js) that imported it from this module.
module.exports = { renderCard, renderAnimatedCard, buildSvg, resolveFace, fetchRegistryIds, levelToKey, TIERS, hasFfmpeg, ANIM_FORMATS };
