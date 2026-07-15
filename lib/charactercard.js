"use strict";

// OpenAgent <-> Character Card (Tavern card) interop — the keystone converter
// (DIVE-1275). The roleplay ecosystem (SillyTavern, Chub, Janitor, HammerAI,
// Agnai, ISEKAI) shares a de-facto persona standard: Character Card V2 / V3, a
// JSON persona blob commonly embedded in a PNG `tEXt` chunk as base64 (`chara`
// for V2, `ccv3` for V3). OpenAgent IS a persona/identity spec, so one converter
// = compatibility with the entire ecosystem instead of N bespoke integrations.
//
// This module is dependency-free (only Node built-ins + `yaml`, already a dep)
// so it stays vendor-neutral and testable without the render stack.
//
// Refs (verified 2026-07-15):
//   V2 spec: github.com/malfoyslastname/character-card-spec-v2
//   V3 spec: github.com/kwaroran/character-card-spec-v3
//   PNG tEXt embedding: the "Tavern card" convention used across the ecosystem.

const zlib = require("zlib");

const CCV2_SPEC = "chara_card_v2";
const CCV3_SPEC = "chara_card_v3";

// ── helpers ──────────────────────────────────────────────────────────────
function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "imported-character";
}

function firstSentence(s) {
  const t = String(s || "").trim();
  if (!t) return "";
  const m = t.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : t).trim();
}

function strArray(a) {
  if (!Array.isArray(a)) return [];
  return a.map((x) => String(x)).filter(Boolean);
}

// Compose a system prompt that makes the character actually behave like the
// persona: who they are, how they act, and their voice rules. This is what a
// roleplay host feeds the model, so it's where the OpenAgent behavior + voice
// layer earns its keep ("a character that actually does work").
function composeSystemPrompt(p) {
  const lines = [];
  const who = [p.name, p.role].filter(Boolean).join(", ");
  if (who) lines.push(`You are ${who}.`);
  if (p.behavior) lines.push(String(p.behavior).trim());
  const rules = strArray(p.voice && p.voice.written && p.voice.written.rules);
  if (rules.length) {
    lines.push("Voice and style:");
    for (const r of rules) lines.push(`- ${r}`);
  }
  return lines.join("\n").trim();
}

// ── persona -> Character Card ─────────────────────────────────────────────
// version: "v2" | "v3" (default v3 — superset, and what current hosts prefer).
function personaToCharacterCard(persona, opts = {}) {
  const p = persona || {};
  const version = (opts.version || "v3").toLowerCase();
  const avatar =
    (p.links && (p.links.avatar || p.links.profile)) ||
    (p.face && typeof p.face.ref === "string" && /^https?:\/\//.test(p.face.ref) ? p.face.ref : "") ||
    "";
  const creator =
    (p.org && p.org.name) ||
    (p.provenance && p.provenance.created_by && p.provenance.created_by.name) ||
    "";
  const sample = (p.voice && p.voice.written && p.voice.written.sample) || "";

  const data = {
    name: p.name || p.id || "Character",
    description: String(p.behavior || p.role || "").trim(),
    personality: String(p.role || "").trim(),
    scenario: "",
    first_mes: String(sample).trim(),
    mes_example: "",
    creator_notes:
      `OpenAgent persona "${p.id || slugify(p.name)}". ` +
      `Unlike a static roleplay card, this identity can be backed by a live agent that actually does work — see openagent.5dive.ai.`,
    system_prompt: composeSystemPrompt(p),
    post_history_instructions: "",
    alternate_greetings: [],
    tags: strArray(p.posts_about),
    creator: String(creator || "").trim(),
    character_version: String(p.openagent || "").trim(),
    // extensions is the sanctioned round-trip channel: stash the WHOLE original
    // persona so `--from-charactercard` can restore it byte-for-byte instead of
    // lossily re-synthesizing. Other hosts ignore unknown extension namespaces.
    extensions: { openagent: { spec: p.openagent || "0.2", persona: p } },
  };

  if (version === "v2") {
    return { spec: CCV2_SPEC, spec_version: "2.0", data };
  }
  // V3 superset fields.
  data.nickname = "";
  data.group_only_greetings = [];
  data.creator_notes_multilingual = {};
  data.source = avatar && /^https?:\/\//.test(avatar) ? [avatar] : [];
  data.assets = avatar
    ? [{ type: "icon", uri: avatar, name: "main", ext: avatar.split(".").pop().split("?")[0].slice(0, 4) || "png" }]
    : [{ type: "icon", uri: "ccdefault:", name: "main", ext: "png" }];
  return { spec: CCV3_SPEC, spec_version: "3.0", data };
}

// ── Character Card -> persona ─────────────────────────────────────────────
// Accepts a wrapped V2/V3 card OR a bare `data` object. If the card was itself
// produced from an OpenAgent persona (extensions.openagent.persona present), we
// restore that original for a lossless round-trip; otherwise we synthesize a
// valid persona from the Tavern fields.
function characterCardToPersona(card) {
  const c = card || {};
  const data = c.data && typeof c.data === "object" ? c.data : c;

  const ext = data.extensions && typeof data.extensions === "object" ? data.extensions : {};
  if (ext.openagent && ext.openagent.persona && typeof ext.openagent.persona === "object") {
    // Round-trip: the persona rode along in extensions. Return it verbatim.
    return { persona: ext.openagent.persona, roundTripped: true };
  }

  const name = String(data.name || "Imported Character").trim();
  const role =
    String(data.personality || "").trim() ||
    firstSentence(data.description) ||
    "Character";
  const behavior =
    String(data.description || "").trim() ||
    String(data.personality || "").trim() ||
    String(data.system_prompt || "").trim() ||
    name;

  // A face ref is required by the schema (string). Prefer a real avatar asset;
  // otherwise leave it empty so the renderer falls back to a monogram.
  let avatar = "";
  if (Array.isArray(data.assets)) {
    const icon = data.assets.find((a) => a && a.type === "icon" && typeof a.uri === "string" && /^https?:\/\//.test(a.uri));
    if (icon) avatar = icon.uri;
  }
  if (!avatar && Array.isArray(data.source)) {
    const s = data.source.find((u) => typeof u === "string" && /^https?:\/\//.test(u));
    if (s) avatar = s;
  }

  const rules = [];
  const creator = String(data.creator || "").trim();
  const specTag = c.spec === CCV3_SPEC ? "V3" : c.spec === CCV2_SPEC ? "V2" : "";
  rules.push(`imported from Character Card${specTag ? " " + specTag : ""}${creator ? ` (creator: ${creator})` : ""}`);
  if (data.system_prompt && String(data.system_prompt).trim()) {
    rules.push("stay in character; honor the imported system prompt");
  }

  const persona = {
    openagent: "0.2",
    id: slugify(name),
    name,
    role,
    behavior,
    posts_about: strArray(data.tags),
    face: {
      ref: avatar,
      anchor: `${name} — imported from a Character Card`,
    },
    voice: {
      written: {
        rules,
        sample: String(data.first_mes || data.mes_example || "").trim() || `Hi, I'm ${name}.`,
      },
    },
  };
  if (creator) persona.org = { name: creator };
  return { persona, roundTripped: false };
}

// ── PNG tEXt embedding / extraction ───────────────────────────────────────
// Tavern cards are usually shipped as PNGs with the card JSON base64-encoded in
// a tEXt chunk keyed "chara" (V2) or "ccv3" (V3). We support reading both, plus
// zTXt (zlib-compressed) which some exporters emit.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG);
}

// CRC-32 (PNG polynomial) — table built once at load, no Math.random needed.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function* pngChunks(buf) {
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) break;
    yield { type, data: buf.subarray(dataStart, dataEnd), start: off, end: dataEnd + 4 };
    off = dataEnd + 4;
  }
}

// Return the embedded Character Card JSON (parsed) from a PNG buffer, or null.
// Prefers ccv3 over chara (V3 is the richer superset when both are present).
function readCharaFromPng(buf) {
  if (!isPng(buf)) return null;
  const found = {};
  for (const ch of pngChunks(buf)) {
    if (ch.type !== "tEXt" && ch.type !== "zTXt") continue;
    const nul = ch.data.indexOf(0x00);
    if (nul < 0) continue;
    const keyword = ch.data.toString("latin1", 0, nul).toLowerCase();
    if (keyword !== "chara" && keyword !== "ccv3") continue;
    let text;
    if (ch.type === "tEXt") {
      text = ch.data.subarray(nul + 1).toString("latin1");
    } else {
      // zTXt: keyword \0 compressionMethod(1) compressedData
      try {
        text = zlib.inflateSync(ch.data.subarray(nul + 2)).toString("latin1");
      } catch {
        continue;
      }
    }
    try {
      const json = Buffer.from(text, "base64").toString("utf8");
      found[keyword] = JSON.parse(json);
    } catch {
      /* not a valid base64/JSON payload — skip */
    }
  }
  return found.ccv3 || found.chara || null;
}

// Build a tEXt chunk (keyword \0 text) with a valid CRC.
function makeTextChunk(keyword, text) {
  const body = Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.from([0]), Buffer.from(text, "latin1")]);
  const typeAndBody = Buffer.concat([Buffer.from("tEXt", "latin1"), body]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndBody), 0);
  return Buffer.concat([len, typeAndBody, crc]);
}

// Embed a Character Card into a base PNG, returning a new PNG buffer. Writes the
// card under BOTH `chara` (V2 compatibility) and `ccv3` (when the card is V3) so
// every host in the ecosystem can read it. Strips any pre-existing chara/ccv3
// tEXt chunks first so we never double-embed.
function writeCharaToPng(basePng, card) {
  if (!isPng(basePng)) throw new Error("base image is not a PNG (Tavern cards must be PNG)");
  const b64 = Buffer.from(JSON.stringify(card), "utf8").toString("base64");
  const chunks = [];
  let iendChunk = null;
  for (const ch of pngChunks(basePng)) {
    if (ch.type === "tEXt" || ch.type === "zTXt") {
      const nul = ch.data.indexOf(0x00);
      const kw = nul >= 0 ? ch.data.toString("latin1", 0, nul).toLowerCase() : "";
      if (kw === "chara" || kw === "ccv3") continue; // drop stale card chunks
    }
    const full = basePng.subarray(ch.start, ch.end);
    if (ch.type === "IEND") iendChunk = full;
    else chunks.push(full);
  }
  const isV3 = card && card.spec === CCV3_SPEC;
  const textChunks = [makeTextChunk("chara", b64)];
  if (isV3) textChunks.push(makeTextChunk("ccv3", b64));
  const parts = [PNG_SIG, ...chunks, ...textChunks];
  if (iendChunk) parts.push(iendChunk);
  return Buffer.concat(parts);
}

module.exports = {
  personaToCharacterCard,
  characterCardToPersona,
  readCharaFromPng,
  writeCharaToPng,
  isPng,
  composeSystemPrompt,
  slugify,
  CCV2_SPEC,
  CCV3_SPEC,
};
