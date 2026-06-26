"use strict";

const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const { computeTier, TIER_NAMES } = require("./tier");
const { TIER_TOKENS, keyForLevel } = require("./tokens");
const { validateFile } = require("./validate");
const { fetchRegistryIds } = require("./registry");
const { didKeyFromPublicKey, shortDidKey, fingerprintFromDidKey } = require("./provenance");
const qrgen = require("qrcode-generator");

// @resvg/resvg-js is an OPTIONAL dependency — it's the native rasterizer, needed
// ONLY to turn the SVG into a PNG/animated card. Everything else (validate, tier,
// sign, verify, and SVG generation via buildSvg/buildAnimatedSvg) is pure JS and
// must work without it, so `npx openagent validate` stays a light, dep-free install.
// Lazy-load it only on the raster paths; if it's absent, those paths return a
// clear "install the optional dep (or output .svg)" message instead of the whole
// CLI hard-crashing at require time.
let _Resvg; // cached: undefined = not tried, null = unavailable, fn = loaded
function loadResvg() {
  if (_Resvg === undefined) {
    try { _Resvg = require("@resvg/resvg-js").Resvg; }
    catch (_) { _Resvg = null; }
  }
  return _Resvg;
}
const RESVG_MISSING =
  "PNG/animated cards need the optional @resvg/resvg-js rasterizer, which isn't " +
  "installed. Install it (npm i @resvg/resvg-js) or render the vector card with " +
  "-o <name>.svg — validate/tier/sign/verify and SVG output work without it.";

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
// Approximate per-glyph advance as a fraction of the font size. The old wrap
// assumed one flat Latin average (0.515) for every script, so wider scripts
// (Cyrillic/Greek) overran the card edge and CJK/Hangul — which are ~full-em
// AND have no spaces to break on — overran badly. These factors are measured
// against Inter/Noto advances.
function glyphFactor(code) {
  // CJK ideographs, kana, Hangul, fullwidth forms → ~1 em
  if (
    (code >= 0x1100 && code <= 0x11ff) ||   // Hangul Jamo
    (code >= 0x2e80 && code <= 0x303e) ||   // CJK radicals / Kangxi / symbols
    (code >= 0x3041 && code <= 0x33ff) ||   // kana, CJK symbols
    (code >= 0x3400 && code <= 0x9fff) ||   // CJK unified (+ ext A)
    (code >= 0xac00 && code <= 0xd7a3) ||   // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) ||   // CJK compatibility
    (code >= 0xff01 && code <= 0xff60) ||   // fullwidth forms
    (code >= 0x20000 && code <= 0x3ffff)    // CJK ext B+
  ) return 1.0;
  if (code >= 0x0370 && code <= 0x04ff) return 0.54;  // Greek + Cyrillic — measured advance, fills width without overrun
  return 0.515;                                       // Latin / default
}

// `wrap` splits `text` to fit `maxW` px at font size `fsz`, capped at `maxLines`
// (the overflow line ends in "…"). ASCII/Latin text takes the ORIGINAL
// char-count path verbatim so existing English/accented cards stay
// byte-identical; only text containing wider scripts (≥ U+0370: Greek, Cyrillic,
// CJK, …) uses the width-aware path below.
function wrap(text, maxW, fsz, maxLines) {
  const s = String(text);
  // Stay on the original path unless a glyph is actually mis-sized by the flat
  // 0.515 assumption (Greek/Cyrillic/CJK). Typographic punctuation (dashes,
  // arrows, curly quotes) is 0.515 like Latin, so English cards keep the
  // original wrap and stay byte-identical.
  const hasWide = [...s].some((ch) => glyphFactor(ch.codePointAt(0)) !== 0.515);
  if (!hasWide) {
    // —— original Latin path (unchanged) ——
    const cw = fsz * 0.515;
    const per = Math.max(1, Math.floor(maxW / cw));
    const words = s.split(/\s+/).filter(Boolean);
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
  // —— width-aware path for wider scripts ——
  const cw = (ch) => glyphFactor(ch.codePointAt(0)) * fsz;
  const lines = [];
  let line = "", lineW = 0, lastSpace = -1; // lastSpace = index of last space in `line`
  for (const ch of s) {
    const w = cw(ch);
    if (line && lineW + w > maxW) {
      if (lastSpace >= 0 && lastSpace < line.length - 1) {
        // break at the last space — keeps whole words together where possible
        const tail = line.slice(lastSpace + 1);
        lines.push(line.slice(0, lastSpace));
        line = tail; lineW = [...tail].reduce((a, c) => a + cw(c), 0);
      } else {
        // no usable space (e.g. CJK run) → hard break before this glyph
        lines.push(line); line = ""; lineW = 0;
      }
      lastSpace = -1;
    }
    if (ch === " ") lastSpace = line.length;
    line += ch; lineW += w;
  }
  if (line) lines.push(line);
  if (maxLines && lines.length > maxLines) {
    const ellW = cw("…");
    let last = lines[maxLines - 1];
    let lw = [...last].reduce((a, c) => a + cw(c), 0);
    while (last && lw + ellW > maxW) { const c = [...last].pop(); lw -= cw(c); last = last.slice(0, -c.length); }
    lines.length = maxLines;
    lines[maxLines - 1] = last.replace(/\s+$/, "") + "…";
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

// Sniff the REAL image type from magic bytes — the source of truth, since both
// the filename extension and the HTTP Content-Type can lie. pollinations/FLUX
// hands back JPEG bytes under a .png name; a data URI mislabeled image/png makes
// resvg silently drop the face and render a portrait-less card. Returns null
// when the bytes match no known raster format.
// Signatures: https://en.wikipedia.org/wiki/List_of_file_signatures
function mimeFromBytes(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return "image/webp";
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
      const buf = Buffer.from(await res.arrayBuffer());
      // Trust the bytes over the Content-Type/extension (both can lie).
      const mime = mimeFromBytes(buf) || (ct && ct.startsWith("image/") ? ct : mimeForExt(ref));
      if (!mime) return { dataUri: null, resolved: false };
      return { dataUri: `data:${mime};base64,${buf.toString("base64")}`, resolved: true };
    } catch (_) {
      return { dataUri: null, resolved: false };
    }
  }

  const extMime = mimeForExt(ref);
  const candidates = path.isAbsolute(ref)
    ? [ref]
    : [path.resolve(baseDir, ref), path.resolve(process.cwd(), ref)];
  for (const abs of candidates) {
    try {
      const buf = fs.readFileSync(abs);
      // Magic bytes win over the extension; fall back to the extension only when
      // the bytes are unrecognised (e.g. an extensionless but valid file).
      const mime = mimeFromBytes(buf) || extMime;
      if (!mime) return { dataUri: null, resolved: false };
      return { dataUri: `data:${mime};base64,${buf.toString("base64")}`, resolved: true };
    } catch (_) { /* next */ }
  }
  return { dataUri: null, resolved: false };
}


// Download a URL to a local file. Best-effort, never throws. (DIVE-723)
async function fetchToFile(url, dest, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    if (!res || !res.ok) return false;
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    return true;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(t);
  }
}

// Materialize a registry handle's SIGNED pack into a local temp dir so the
// existing renderers (which take a file path and resolve `./avatar.png` relative
// to it) render the OFFICIAL card untouched — same persona, did:key, tier, and
// monogram the gallery shows. Without this, content hand-assembles raw URLs (or
// worse, renders a local working copy that re-mints a wrong identity). Downloads
// persona.yaml plus any LOCAL (./-relative) face.ref / face.sprite siblings;
// remote refs are left for the renderer to fetch. Returns
// { ok, file, dir, pack, sourceName, official } or { ok:false, error, available }.
async function materializeHandle(slug, opts = {}) {
  const reg = require("./registry");
  const r = await reg.resolveHandle(slug, opts);
  if (!r.found) {
    return {
      ok: false,
      error: r.error || `handle "${slug}" not found in any trusted registry`,
      available: r.available || [],
    };
  }
  const packBase = r.baseUrl + String(r.pack.path).replace(/\/+$/, "") + "/";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagent-card-"));
  const personaFile = path.join(dir, "persona.yaml");
  if (!(await fetchToFile(packBase + "persona.yaml", personaFile))) {
    return { ok: false, error: `could not fetch signed persona for "${slug}" (${packBase}persona.yaml)`, available: [] };
  }
  let persona = {};
  try { persona = YAML.parse(fs.readFileSync(personaFile, "utf8")) || {}; } catch (_) {}
  const refs = [persona.face && persona.face.ref, persona.face && persona.face.sprite];
  for (const ref of refs) {
    if (typeof ref !== "string" || /^https?:\/\//i.test(ref) || path.isAbsolute(ref)) continue;
    const rel = ref.replace(/^\.\//, "");
    // best-effort: a missing avatar just degrades to the monogram fallback
    await fetchToFile(packBase + rel, path.join(dir, path.basename(rel)));
  }
  return { ok: true, file: personaFile, dir, pack: r.pack, sourceName: r.sourceName, official: r.official };
}

// QR (DIVE — card v2): the top-right QR encodes the agent's did:key so a scan
// resolves its decentralized provenance offline (a verify-URL variant can come
// later once a verify page exists). Rendered ONLY for SIGNED personas (those
// carrying provenance.created_by.key); unsigned cards degrade clean (no QR).
// Pure-JS + VECTOR: qrcode-generator builds the boolean module matrix (zero new
// transitive deps) and the pill draws the dark modules as <rect>s — so the QR
// stays a vector with NO rasterizer at generation time. That keeps the live
// buildAnimatedSvg path resvg-free (Marcus's zero-resvg goal); the preview PNG
// just lets the existing resvg rasterize the whole vector card (QR included) in
// one pass. Returns null when unsigned / key unusable, so the pill omits the QR.
function didKeyForPersona(persona) {
  try {
    const k = persona && persona.provenance && persona.provenance.created_by && persona.provenance.created_by.key;
    return k ? didKeyFromPublicKey(k) : null;
  } catch (_) {
    return null;
  }
}
function qrModulesForPersona(persona) {
  const didKey = didKeyForPersona(persona);
  if (!didKey) return null;
  try {
    const qr = qrgen(0, "M"); // auto type number, medium error-correction
    qr.addData(didKey);
    qr.make();
    const n = qr.getModuleCount();
    const modules = [];
    for (let r = 0; r < n; r++) {
      const row = [];
      for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
      modules.push(row);
    }
    return modules; // n×n boolean grid (true = dark module)
  } catch (_) {
    return null; // never let QR generation break a card render
  }
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
function buildSvg(persona, faceDataUri, tierKey, motion, qrModules, extra) {
  const orgVerified = !!(extra && extra.orgVerified);
  const W = 900, H = 1260, P = 48, innerW = W - 2 * P;
  const T = TIERS[tierKey] || TIERS.common;
  const A = T.accent;
  const anim = motion && typeof motion.phase === "number";
  const smil = !!(motion && motion.smil); // self-animating SVG (SMIL) — browser-native, zero rasterizer
  const phase = anim ? ((motion.phase % 1) + 1) % 1 : 0; // wrapped 0..1
  const TAU = Math.PI * 2;
  // The card ACTIVATES during the holo pass (first SWEEP_FRAC of the loop), then sits fully
  // STATIC for the rest — so a frame-dedup encoder collapses the rest to ~1 frame (apng size).
  const SWEEP_FRAC = 0.25;
  const inPass = anim && phase < SWEEP_FRAC;
  const passF = inPass ? phase / SWEEP_FRAC : 0; // 0..1 across the pass
  const breath = inPass ? 0.85 + 0.15 * Math.sin(Math.PI * passF) : 1; // one glow swell on the pass, parked at rest
  // Motion intensity laddered to rarity (Lil bro's note): Common the subtlest
  // pulse → Mythical the most alive, so the baseline motion REINFORCES the tier
  // hierarchy the foil/holo build, instead of flattening it. Scales amplitude
  // (and waveform speed) only — the premium effects stay tier-gated as before.
  const tierLevel = ({ ungraded: 0, common: 1, rare: 2, epic: 3, legendary: 4, mythical: 5 })[tierKey] ?? 1;
  const mi = tierLevel <= 0 ? 0 : 0.35 + 0.65 * (tierLevel - 1) / 4; // 0.35 (Common) → 1.0 (Mythical)
  // Ambient accent-glow breath on every graded tier; depth grows with rarity.
  // One seamless cycle per loop (phase 0 == phase 1).
  const ambDepth = 0.08 + 0.10 * mi;
  const ambient = anim ? (1 - ambDepth) + ambDepth * Math.sin(TAU * phase) : 1;
  const rng = mulberry32(hash32((persona.voice?.audio?.base || "") + "|" + (persona.voice?.audio?.style || "") + "|" + (persona.id || "")));

  const name = persona.name || persona.id || "Unknown";
  const role = persona.role || "";
  const behavior = persona.behavior || "";
  const audio = persona.voice?.audio;
  const written = persona.voice?.written;

  const heroH = 688, R = 40;
  const side = Math.max(W, heroH);
  const ix = (W - side) / 2, iy = (heroH - side) / 2;
  // Ken Burns: a subtle breathing zoom on the hero portrait, on EVERY tier — the
  // photo slowly pushes in ~2% and back over the loop (seamless: cos → phase 0 ==
  // phase 1). Scaled about the hero centre so the full-bleed slice never gaps.
  // The clip lives on the wrapping <g> so it stays fixed while the image moves.
  const kb = anim ? 1 + (0.012 + 0.016 * mi) * (0.5 - 0.5 * Math.cos(TAU * phase)) : 1;
  const kbTf = ` transform="translate(${W / 2} ${heroH / 2}) scale(${kb.toFixed(4)}) translate(${-W / 2} ${-heroH / 2})"`;
  // Static cards keep the original (byte-identical) form; only the animated card
  // wraps the image in a clip-group so the Ken Burns transform can move it.
  const face = faceDataUri
    ? (anim
        ? `<g clip-path="url(#heroClip)"><image href="${faceDataUri}" x="${ix}" y="${iy}" width="${side}" height="${side}" preserveAspectRatio="xMidYMid slice"${kbTf}/></g>`
        : `<image href="${faceDataUri}" x="${ix}" y="${iy}" width="${side}" height="${side}" preserveAspectRatio="xMidYMid slice" clip-path="url(#heroClip)"/>`)
    : `<rect width="${W}" height="${heroH}" fill="#15171F" clip-path="url(#heroClip)"/>
       <text x="${W / 2}" y="${heroH / 2}" font-family="Inter Display" font-weight="800" font-size="180" fill="${A}" fill-opacity="0.85" text-anchor="middle" dominant-baseline="central">${esc(name.split(/\s+/).map((w) => w[0] || "").join("").slice(0, 2).toUpperCase())}</text>`;

  let foilLayer = "", glow = "";
  for (let g = 0; g < T.glowN; g++) {
    const w = 3 + g * 3, op = ((0.16 - g * 0.026) * breath).toFixed(3);
    glow += `<rect x="${5 - g}" y="${5 - g}" width="${W - 10 + 2 * g}" height="${H - 10 + 2 * g}" rx="${R - 1 + g}" fill="none" stroke="${A}" stroke-opacity="${op}" stroke-width="${w}"/>`;
  }
  if (T.foil) {
    foilLayer += `<g clip-path="url(#cardClip)">`;
    // DIVE-667 (whisper gloss): only the ANIMATED card gets a sheen, and it's a
    // SINGLE soft, wide, heavily-feathered band making one slow pass per loop — a
    // whisper of travelling shine, never a glare bar. STATIC cards get NO diagonal
    // streak (a frozen light bar is the ugliest thing on a still — lodar's #1 fix);
    // the tier still reads via the foil frame stroke, glow rings, and sparkle
    // speckle. Mythical keeps a hair more presence for the holo look.
    if (anim) {
      // same sweep SPEED, ONE pass per loop then a long REST. The band sweeps across only
      // in the first 25% of the loop (~3s at a 12s loop = original velocity), then it's
      // invisible/parked for the remaining 75% — so the holo passes once and the card sits
      // calm, never a ~1s strobe. Loop length lives in renderAnimatedCard (target ~12s);
      // lengthening the loop lengthens the REST, not the sweep.
      const span = W + 600, sweepFrac = 0.25;
      if (phase < sweepFrac) {
        const f = phase / sweepFrac;                                  // 0..1 across the pass
        const cx = (-300 + f * span).toFixed(1);
        const edge = f < 0.1 ? f / 0.1 : f > 0.88 ? (1 - f) / 0.12 : 1; // fade in/out
        const op = ((T.holo ? 0.30 : 0.26) * edge).toFixed(3);
        foilLayer += `<rect x="${cx}" y="-200" width="620" height="${H + 400}" fill="url(#sheen)" transform="rotate(18 ${cx} ${H / 2})" opacity="${op}"/>`;
      }
    } else if (smil) {
      // SMIL: a rotated sheen band sweeps across forever, fading at the edges. Browser runs
      // it live; resvg ignores <animate> and rasterizes a static frame for the preview PNG.
      const peak = T.holo ? 0.34 : 0.28;
      foilLayer += `<g transform="rotate(16 ${W / 2} ${H / 2})"><rect y="-320" width="520" height="${H + 640}" fill="url(#sheen)" opacity="0">`
        // same sweep SPEED, longer LOOP: the band crosses in ~4.5s (keyTime 0.375 of a 12s
        // loop), then rests off-screen + invisible for the rest. one calm pass every 12s.
        + `<animate attributeName="x" values="-420;${W + 220};${W + 220}" keyTimes="0;0.25;1" dur="6s" repeatCount="indefinite"/>`
        + `<animate attributeName="opacity" values="0;${peak};${peak};0;0" keyTimes="0;0.03;0.22;0.25;1" dur="6s" repeatCount="indefinite"/>`
        + `</rect></g>`;
    }
    // Sparkle positions stay seeded/identical across frames (rng re-seeded each
    // call in the same order); only the holo hue rotates with phase so the
    // rainbow speckle flows without the dots jittering.
    const hueShift = anim && T.holo ? phase * 360 : 0;
    let spk = "";
    for (let i = 0; i < (T.holo ? 220 : 140); i++) {
      const x = (rng() * W).toFixed(1), y = (rng() * H).toFixed(1), r = (rng() * 1.5 + 0.4).toFixed(2);
      const c = T.holo ? `hsl(${Math.floor((rng() * 360 + hueShift) % 360)},90%,72%)` : A;
      spk += `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}" fill-opacity="${(0.07 + rng() * 0.12).toFixed(3)}"/>`;
    }
    // A few subtle 4-point star glints that twinkle in WITH the holo pass (animated only).
    let stars = "";
    for (let i = 0; i < 12; i++) {
      const x = (60 + rng() * (W - 120)).toFixed(1), y = (60 + rng() * (heroH - 120)).toFixed(1), s = +(rng() * 3.5 + 4.5).toFixed(1);
      stars += `<path transform="translate(${x} ${y})" d="M0 ${-s} Q ${(s*0.16).toFixed(1)} ${(-s*0.16).toFixed(1)} ${s} 0 Q ${(s*0.16).toFixed(1)} ${(s*0.16).toFixed(1)} 0 ${s} Q ${(-s*0.16).toFixed(1)} ${(s*0.16).toFixed(1)} ${-s} 0 Q ${(-s*0.16).toFixed(1)} ${(-s*0.16).toFixed(1)} 0 ${-s} Z" fill="#fff" fill-opacity="0.62"/>`;
    }
    // Sparkle + stars come SUBTLY when the holo sweep passes, then fade for the calm rest.
    if (smil) {
      foilLayer += `<g opacity="0">${spk}${stars}<animate attributeName="opacity" values="0;0.88;0;0" keyTimes="0;0.13;0.25;1" dur="6s" repeatCount="indefinite"/></g>`;
    } else if (anim) {
      const sw = phase < 0.25 ? phase / 0.25 : -1;
      const sparkOp = sw < 0 ? 0 : +(Math.sin(Math.PI * sw) * 0.88).toFixed(3);
      if (sparkOp > 0.01) foilLayer += `<g opacity="${sparkOp}">${spk}${stars}</g>`;
    } else {
      foilLayer += spk; // static card: subtle speckle only, no glints/animation
    }
    foilLayer += `</g>`;
  }
  if (T.holo) {
    const washOp = anim ? (0.16 * breath).toFixed(3) : "0.16";
    foilLayer = `<rect x="0" y="0" width="${W}" height="${H}" rx="${R}" fill="url(#holoWash)" opacity="${washOp}"/>` + foilLayer;
  }

  const bw = 52 + T.label.length * 12.5, bh = 42, bx = P, by = 40;
  const badge = `
    <g>
      <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${bh / 2}" fill="rgba(8,9,14,0.62)" stroke="${A}" stroke-opacity="0.9" stroke-width="1.5"/>
      <path d="M ${bx + 24} ${by + 11} l 9 8 l -9 12 l -9 -12 z" fill="${T.gem}" ${T.holo ? "" : `fill-opacity="0.95"`}/>
      <text x="${bx + 44}" y="${by + bh / 2 + 5}" font-family="DejaVu Sans Mono" font-weight="bold" font-size="15" letter-spacing="1.5" fill="#fff">${esc(T.label)}</text>
    </g>`;
  // level dots under the rarity badge (filled = this tier's rank, of 5)
  const level = { ungraded: 0, common: 1, rare: 2, epic: 3, legendary: 4, mythical: 5 }[tierKey] ?? 0;
  let pips = "<g>";
  for (let i = 0; i < 5; i++) {
    const on = i < level;
    pips += `<circle cx="${bx + 13 + i * 30}" cy="${by + bh + 23}" r="9" fill="${on ? A : "#454b57"}"${on ? "" : ` fill-opacity="0.6"`}/>`;
  }
  pips += "</g>";
  // QR (top-right): scan -> verify the agent's did:key. Rendered only when the
  // caller supplies a QR data-URI (generated from the signed persona's did:key).
  // Balances the rarity badge on the left.
  let qr = "";
  if (qrModules && qrModules.length) {
    const qs = 132, qp = 16, qx = W - P - (qs + 2 * qp), qy = 40;
    const n = qrModules.length, margin = 2, cell = qs / (n + margin * 2);
    let cells = "";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qrModules[r][c]) cells += `<rect x="${((c + margin) * cell).toFixed(2)}" y="${((r + margin) * cell).toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}"/>`;
      }
    }
    // dark pill + white quiet-zone plate behind the modules (scan contrast),
    // then the vector QR modules. Pure <rect>s — no <image>, no rasterizer.
    // The QR catches the light as the holo sweep crosses it: a soft diagonal shine clipped to
    // the plate, GATED to the pass window so the rest stays byte-static (apng dedup).
    const gx0 = qx + qp - 50, gW = qs + 80;
    const gClip = `<clipPath id="qrGlint"><rect x="${qx + qp}" y="${qy + qp}" width="${qs}" height="${qs}" rx="6"/></clipPath>`;
    let qrGlint = "";
    if (smil) {
      qrGlint = `${gClip}<g clip-path="url(#qrGlint)"><rect x="${gx0}" y="${qy + qp - 20}" width="44" height="${qs + 40}" fill="url(#sheen)" transform="rotate(20 ${qx + qp} ${qy + qp})" opacity="0">`
        + `<animate attributeName="x" values="${gx0};${gx0};${gx0 + gW};${gx0 + gW}" keyTimes="0;0.17;0.235;1" dur="6s" repeatCount="indefinite"/>`
        + `<animate attributeName="opacity" values="0;0;0.75;0.75;0;0" keyTimes="0;0.17;0.18;0.225;0.235;1" dur="6s" repeatCount="indefinite"/></rect></g>`;
    } else if (anim) {
      const g0 = 0.68, g1 = 0.98; // the sweep reaches the QR near the end of the pass
      if (inPass && passF >= g0 && passF <= g1) {
        const gf = (passF - g0) / (g1 - g0);
        const gxr = (gx0 + gf * gW).toFixed(1);
        const gop = (Math.sin(Math.PI * gf) * 0.75).toFixed(3);
        qrGlint = `${gClip}<g clip-path="url(#qrGlint)"><rect x="${gxr}" y="${qy + qp - 20}" width="44" height="${qs + 40}" fill="url(#sheen)" transform="rotate(20 ${gxr} ${qy + qp})" opacity="${gop}"/></g>`;
      }
    }
    qr = `<g>
      <rect x="${qx}" y="${qy}" width="${qs + 2 * qp}" height="${qs + 2 * qp}" rx="18" fill="rgba(8,9,14,0.66)" stroke="${A}" stroke-opacity="0.6" stroke-width="2"/>
      <rect x="${qx + qp}" y="${qy + qp}" width="${qs}" height="${qs}" rx="6" fill="#ffffff"/>
      <g transform="translate(${qx + qp} ${qy + qp})" fill="#0A0B11">${cells}</g>
      ${qrGlint}
    </g>`;
  }

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
  // Waveform liveliness laddered by rarity: deeper pulse + more cycles up the
  // ladder. Cycles are kept INTEGER so the loop stays seamless (phase 0 == 1).
  const wfDepth = 0.12 + 0.16 * mi;
  const wfCyc = Math.max(1, Math.round(1 + mi * 3));
  for (let i = 0; i < bars; i++) {
    const base = 0.12 + Math.pow(rng(), 0.8) * 0.88;
    // per-bar phase offset (stable across frames) so bars don't pulse in lockstep.
    // Only consumed when animating, so the STATIC card keeps its exact rng sequence
    // (byte-identical static render — DIVE-665).
    const off = anim ? rng() : 0;
    // Live voiceprint: on EVERY tier the bars gently breathe like a real audio
    // meter — two seamless cycles per loop (phase 0 == phase 1). This is the
    // universal "something moves on every card" baseline (DIVE-???), independent
    // of the tier-specific foil/holo choreography. Static render: no wobble.
    const wob = anim ? (1 - wfDepth) + wfDepth * Math.sin(TAU * (phase * wfCyc + off)) : 1;
    const amp = Math.min(1, base * wob);
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

  // Friendly id: handle·fingerprint (e.g. olivia·z8jrr2) — the human-readable,
  // verifiable id derived from the agent's did:key. Present only on signed
  // personas; absent ones render byte-identically to before. The full did:key
  // address comes from `verify` / the gallery card page.
  let friendlyId = "";
  try {
    const k = persona.provenance && persona.provenance.created_by && persona.provenance.created_by.key;
    if (k) friendlyId = `${persona.id || ""}·${fingerprintFromDidKey(didKeyFromPublicKey(k))}`;
  } catch (_) {
    /* unusable key → no handle on the card */
  }

  const footY = H - 44;
  body += `<rect x="${P}" y="${footY - 30}" width="${innerW}" height="1" fill="#fff" fill-opacity="0.07"/>`;
  // footer left mark: "#openagent", + the agent's org when declared (Marcus spec:
  // top-level persona.org.name). Hidden when absent; truncated ~18 chars so it
  // never crowds the right-side did:key · id · version.
  const orgName = persona.org && persona.org.name ? String(persona.org.name).trim() : "";
  const orgDisp = orgName.length > 18 ? orgName.slice(0, 18) + "…" : orgName;
  const footMark = orgDisp ? `#openagent · ${orgDisp}` : "#openagent";
  body += `<text x="${P}" y="${footY}" font-family="DejaVu Sans Mono" font-weight="bold" font-size="18" letter-spacing="1" fill="#6B7388">${esc(footMark)}</text>`;
  // VERIFIED ORG badge — only when the caller proved the org's did:web attestation
  // (lib/org.verifyOrgAffiliation). A green ✓ trailing the org name on the footer:
  // self-declared org.name renders plain; a domain-proven one earns the check.
  if (orgVerified && orgDisp) {
    const markW = (`#openagent · ${orgDisp}`).length * 11; // mono ~11px/char @ 18
    body += `<text x="${P + markW + 10}" y="${footY}" font-family="DejaVu Sans Mono" font-weight="bold" font-size="18" fill="#3DD68C">✓</text>`;
  }
  const ver = `v${persona.openagent || "0.1"}`;
  // Signed → friendly id + version (olivia·z8jrr2 · v0.2). Unsigned → id + version.
  const rightFoot = friendlyId ? `${friendlyId}  ·  ${ver}` : `${persona.id || ""} · ${ver}`;
  body += `<text x="${W - P}" y="${footY}" font-family="DejaVu Sans Mono" font-size="18" fill="#6B7388" text-anchor="end">${esc(rightFoot)}</text>`;

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
      <stop offset="0" stop-color="#fff" stop-opacity="0"/>
      <stop offset="0.35" stop-color="#fff" stop-opacity="0.22"/>
      <stop offset="0.5" stop-color="#fff" stop-opacity="0.55"/>
      <stop offset="0.65" stop-color="#fff" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
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

  <g clip-path="url(#cardClip)">
  <rect x="0" y="0" width="${W}" height="${H}" rx="${R}" fill="url(#bg)"/>
  <rect x="0" y="0" width="${W}" height="${H}" rx="${R}" fill="url(#topGlow)"${anim ? ` opacity="${ambient.toFixed(3)}"` : ""}/>
  ${face}
  <rect x="0" y="0" width="${W}" height="${heroH}" fill="url(#scrim)" clip-path="url(#heroClip)"/>
  ${foilLayer}
  ${roleKicker}
  ${nameSvg}
  ${badge}
  ${pips}
  ${qr}
  ${body}
  ${glow}
  ${frame}
  </g>
</svg>`;
}

// Self-animating SVG card (SMIL) — the DEFAULT live card. Opens in any browser with the holo
// running natively, ZERO rasterizer dep. resvg ignores <animate> and gives a static preview PNG.
// QR (from the agent's did:key) is generated by the caller, same as the static path.
function buildAnimatedSvg(persona, faceDataUri, tierKey, qrModules) {
  return buildSvg(persona, faceDataUri, tierKey, { smil: true }, qrModules);
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
    inRegistry = (await fetchRegistryIds({ registryFlags: opts.registryFlags })).has(persona.id);
  }

  const schemaValid = validateFile(file).ok;
  const tier = computeTier(persona, { faceResolved: face.resolved, inRegistry, schemaValid });
  const qrModules = qrModulesForPersona(persona);
  // Verified-org badge: opt-in. The caller (gallery / `openagent card`) resolves
  // the did:web attestation and passes the verdict; we never fetch it here so a
  // forged org.verification block can't self-award the ✓.
  const orgVerified = opts.orgVerified === true;
  const svg = buildSvg(persona, face.dataUri, levelToKey(tier.level), undefined, qrModules, { orgVerified });

  const out = outPath || `${persona.id || "persona"}.card.png`;

  // Vector output: write the SVG straight out — no rasterizer needed (the
  // resvg-free path). The CLI routes an `-o <name>.svg` here.
  if (/\.svg$/i.test(out)) {
    const svgBuf = Buffer.from(svg, "utf8");
    try { fs.writeFileSync(out, svgBuf); }
    catch (e) { return { ok: false, error: `cannot write ${out}: ${e.message}` }; }
    return {
      ok: true, outPath: out, width: 900, height: 1260, bytes: svgBuf.length,
      tier: tier.tier, level: tier.level, completeness: tier.completeness, faceResolved: face.resolved,
    };
  }

  // Raster output (PNG) needs the optional rasterizer.
  const Resvg = loadResvg();
  if (!Resvg) return { ok: false, error: RESVG_MISSING };

  let pngBuf;
  try {
    const resvg = new Resvg(svg, {
      fitTo: { mode: "width", value: 900 },
      // Bundled fonts (Inter/DejaVu) cover Latin/Cyrillic/Greek and are matched
      // by family name first, so English/official cards stay byte-identical.
      // loadSystemFonts lets non-Latin card text (CJK/Arabic/Thai/…) fall back to
      // the host's system fonts where present — write-in-your-language support.
      font: { fontBuffers: loadFonts(), loadSystemFonts: true, defaultFontFamily: "Inter" },
    });
    pngBuf = resvg.render().asPng();
  } catch (e) {
    return { ok: false, error: `render failed: ${e.message}` };
  }

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
const os = require("os"); // also used by materializeHandle (above)

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
  // Calm cadence (lodar 6/24): one holo pass + a long REST per loop, ~12s total (was ~1.2s = a
  // strobe). ffmpeg formats compress the mostly-static rest, so they default rich (180f@15fps).
  // APNG re-encodes every frame full (no inter-frame delta), so a 12s apng would bloat — keep it
  // lighter (60f@5fps = 12s; the rest is static so low fps reads fine).
  const frames = Math.max(2, Math.min(240, opts.frames || (format === "apng" ? 30 : 90)));
  const fps = Math.max(1, Math.min(60, opts.fps || (format === "apng" ? 5 : 15)));
  const width = Math.max(160, Math.min(900, opts.width || (format === "apng" ? 480 : 720)));

  const baseDir = path.dirname(path.resolve(file));
  const face = await resolveFace(persona.face?.ref, baseDir);

  let inRegistry = false;
  if (opts.checkRegistry !== false) inRegistry = (await fetchRegistryIds({ registryFlags: opts.registryFlags })).has(persona.id);

  const schemaValid = validateFile(file).ok;
  const tier = computeTier(persona, { faceResolved: face.resolved, inRegistry, schemaValid });
  const key = levelToKey(tier.level);

  const h = Math.round((width / 900) * 1260);
  // resvg-js (2.6.2) ignores `fitTo` when a `font` block is also passed, so we
  // scale by rewriting the SVG root's width/height while keeping the 900×1260
  // viewBox — this both honors --width AND keeps APNG frames small (the avatar
  // photo is re-encoded per frame, so resolution drives file size).
  // Every animated format rasterizes frames, so it needs the optional rasterizer.
  const Resvg = loadResvg();
  if (!Resvg) return { ok: false, error: RESVG_MISSING };

  const fontBuffers = loadFonts();
  const qrModules = qrModulesForPersona(persona);
  const pngFrames = [];
  for (let f = 0; f < frames; f++) {
    let svg = buildSvg(persona, face.dataUri, key, { phase: f / frames }, qrModules);
    if (width !== 900) svg = svg.replace('width="900" height="1260"', `width="${width}" height="${h}"`);
    try {
      const resvg = new Resvg(svg, {
        // see renderCard: system-font fallback for non-Latin glyphs; Latin stays byte-identical
        font: { fontBuffers, loadSystemFonts: true, defaultFontFamily: "Inter" },
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
module.exports = { renderCard, renderAnimatedCard, buildSvg, buildAnimatedSvg, qrModulesForPersona, resolveFace, materializeHandle, fetchRegistryIds, levelToKey, TIERS, hasFfmpeg, ANIM_FORMATS };
