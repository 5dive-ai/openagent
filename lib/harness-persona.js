"use strict";

// `openagent init --from=<harness>` (DIVE-6350): an agent that already has a
// name and a persona in its harness keeps them. init reads the same slot files
// `install --to=<harness>` writes (install.js slotsFor: Hermes SOUL.md,
// OpenClaw AGENTS.md / SOUL.md / IDENTITY.md, Claude Code CLAUDE.md, Codex
// AGENTS.md) and proposes what it finds; flags still win, and init fills only
// what is missing.
//
// These files are free text the owner wrote, so the reader is deliberately
// narrow. It takes only what a file states outright:
//   - a "Name: X" / "- **Name:** X" line (OpenClaw's IDENTITY.md shape), and the
//     same for role / job / title, vibe / personality, voice / tone, avatar
//   - "Your name is X", "You are X, the <job>", "I am X" / "I'm X", with X a
//     capitalised name of one to three words (Élodie and Алиса count; an
//     all-caps rule word like NEVER, or a modal like "Done", does not)
// A runtime's stock persona ("You are Hermes Agent, ..." in a fresh SOUL.md) is
// not the agent's own name, so the runtimes' names are skipped. Nothing is
// guessed from headings or prose: a file with no such line proposes nothing.

const fs = require("fs");
const { slotsFor, TARGET_NAMES } = require("./install");

const HARNESSES = ["hermes", "openclaw", "claude-code", "codex"];

// The runtimes' own default identities, never an agent's chosen name.
const STOCK = /^(?:hermes(?: agent)?|claude(?: code)?|codex|openclaw|chatgpt|gpt|assistant|ai assistant|an? ai)$/i;

const KEYS = {
  name: "name",
  role: "role", job: "role", title: "role",
  vibe: "vibe", personality: "vibe",
  voice: "voice", tone: "voice",
  avatar: "avatar",
};
const KEY_LINE = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?(name|role|job|title|vibe|personality|voice|tone|avatar)\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*)$/i;
// A capital then a lowercase letter, in any cased script: "Élodie" and "Алиса" match,
// an all-caps rule word ("You are NEVER to ...") does not.
const WORD = "\\p{Lu}\\p{Ll}[\\p{L}\\p{M}\\p{N}'’-]*";
const NAME = `(${WORD}(?:\\s+${WORD}){0,2})`;
const SENTENCES = [
  new RegExp(`\\b[Yy]our name is\\s+(?:\\*\\*)?${NAME}`, "gu"),
  new RegExp(`\\bYou are\\s+(?:\\*\\*)?${NAME}(?:\\*\\*)?(?:,\\s*([^.\\n]{2,80}))?`, "gu"),
  new RegExp(`\\bI(?: am|'m|’m)\\s+(?:\\*\\*)?${NAME}(?:\\*\\*)?(?:,\\s*([^.\\n]{2,80}))?`, "gu"),
];
// "You are Only allowed to ...", "I am Done when ...": a modal, adverb or state, not a name.
const NOT_A_NAME = /^(?:never|only|always|done|sure|expected|responsible|allowed|required|free|able|also|just|still|ready|careful|here|now|not|going|working|running|a|an|the)$/i;

function clean(v) {
  return String(v || "")
    .replace(/\s*_\([^)]*\)_\s*/g, " ") // OpenClaw's "_(pick something you like)_" placeholders
    .replace(/^[*_`"']+|[*_`"']+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.;,]+$/, "");
}

function goodName(v) {
  const n = clean(v);
  if (!n || n.length > 40 || n.split(" ").length > 4) return "";
  const first = n.split(" ")[0];
  if (STOCK.test(n) || NOT_A_NAME.test(first)) return "";
  // An all-caps first word is a rule word ("NEVER"), not a name.
  if (/\p{Lu}.*\p{Lu}/u.test(first) && !/\p{Ll}/u.test(first)) return "";
  return n;
}

function goodRole(v) {
  const r = clean(v).replace(/^(?:an?|the)\s+/i, "");
  if (!r || r.length > 60 || /^(?:not|and|but|so|who|which|that|built on)\b/i.test(r)) return "";
  return r;
}

// What one file states about the agent. Earlier lines win.
function readText(text) {
  const out = {};
  const set = (k, v) => { if (v && !out[k]) out[k] = v; };
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    const m = KEY_LINE.exec(line);
    if (!m) continue;
    const k = KEYS[m[1].toLowerCase()];
    const v = clean(m[2]);
    if (!v) continue;
    // A name starts with a letter that is not lowercase (Élodie, Алиса, 小明); a lowercase
    // "name:" in a rules file is a slug or a field, not the agent.
    if (k === "name") set("name", /^(?=\p{L})\P{Ll}/u.test(v) ? goodName(v) : "");
    else if (k === "role") set("role", goodRole(v));
    else if (k === "avatar") set("faceRef", /^https?:\/\/\S+$/.test(v) ? v : "");
    else if (v.length <= 200) set(k, v);
  }
  for (const re of SENTENCES) {
    for (const m of String(text || "").matchAll(re)) {
      const name = goodName(m[1]);
      if (!name) continue;
      set("name", name);
      if (out.name === name && m[2]) set("role", goodRole(m[2]));
      break;
    }
  }
  return out;
}

// The proposal for one harness: { files, found: [file...], name?, role?, vibe?, voice?, faceRef? }.
// `found` lists the files that were present; values come from the first file that states them.
function readHarnessPersona(target, opts = {}) {
  if (!HARNESSES.includes(target)) {
    throw new Error(`--from must be one of ${HARNESSES.join(", ")} (the harness you run in), got '${target}'`);
  }
  const files = slotsFor(target, opts).map((s) => s.file);
  // OpenClaw's IDENTITY.md is its name card; read it before AGENTS.md and SOUL.md.
  if (target === "openclaw") files.sort((a, b) => /IDENTITY\.md$/.test(b) - /IDENTITY\.md$/.test(a));
  const out = { harness: TARGET_NAMES[target], files, found: [] };
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    out.found.push(file);
    const got = readText(text);
    for (const k of Object.keys(got)) if (got[k] && !out[k]) out[k] = got[k];
  }
  return out;
}

module.exports = { HARNESSES, readHarnessPersona, readText };
