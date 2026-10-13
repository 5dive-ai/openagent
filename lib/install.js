"use strict";

// `openagent install --to=hermes|openclaw|5dive` — put a persona into the slot
// the runtime ACTUALLY reads for its identity, without deleting what is there.
//
// The slot map is a PORT, not a second derivation. It comes from the 5dive CLI
// (5dive-ai/5dive src/header.sh TYPE_PERSONA_FILE, DIVE-2223/DIVE-2245), whose
// rows were measured with a before/after "who are you?" probe on live seats
// rather than read from docs — and the guessed path was wrong for both:
//   - hermes reads AGENTS.md / CLAUDE.md from the CWD ONLY. The home-level slot
//     is SOUL.md in HERMES_HOME (~/.hermes), "always included when present".
//   - openclaw injects a fixed set of WORKSPACE files (AGENTS.md, SOUL.md,
//     IDENTITY.md, ...) on a session's first turn; the root is
//     ~/.openclaw/workspace, not a pi-shaped dotdir and not the agent's cwd.
// If a row here changes, change it in header.sh too (and re-probe a live seat).
//
// Both are OCCUPIED slots: `hermes` seeds SOUL.md with the Nous default persona
// and openclaw's first-run bootstrap writes its whole workspace set. So we
// PREPEND, like the CLI's persona_install_doc, and never overwrite. Our block
// sits between markers, so a re-install replaces it and --remove takes it back
// out byte-exact, leaving the runtime's own defaults untouched.
//
// openclaw also gets IDENTITY.md (name / creature / vibe). That is not in the
// CLI map: a 5dive seat never runs openclaw's onboarding, but a fresh install
// does — while BOOTSTRAP.md is pending, openclaw runs its "Hey. I just came
// online. Who am I?" ritual. openclaw counts a customized IDENTITY.md as proof
// that onboarding is complete (workspaceProfileLooksConfigured), so filling it
// is what stops the ritual from talking over the persona.
//
// That has a cost on the way back out. Once IDENTITY.md looks customised,
// openclaw's next session marks setup complete and DELETES BOOTSTRAP.md
// (reconcileWorkspaceBootstrapCompletionState). --remove then leaves a
// workspace with no BOOTSTRAP.md and a setup attestation under 24h old, and
// every turn exits 1 ("workspace appears to have disappeared ... Refusing to
// reseed BOOTSTRAP.md") until the 24h pass (measured on a fresh box, DIVE-6140).
// So install saves a pending BOOTSTRAP.md under ~/.openagent/backups, and
// --remove puts it back byte-exact if openclaw consumed it.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { agentHome } = require("./keystore");

const TARGETS = ["hermes", "openclaw", "5dive"];

const BEGIN = (id) => `<!-- openagent:begin id=${id} — written by \`openagent install\`; remove with \`openagent install --to=<runtime> --remove\` -->`;
const END = "<!-- openagent:end -->";
// Our own block plus the blank line we put between it and the runtime's text.
const BLOCK_RE = /<!-- openagent:begin[^\n]*-->\n[\s\S]*?\n<!-- openagent:end -->\n(\n)?/g;

// Where each runtime's slots live. `dir` overrides the slot directory (a hermes
// home or an openclaw workspace — e.g. ~/.openclaw/workspace-<name> for a named
// openclaw agent). `home` overrides $HOME, for tests.
function slotsFor(target, opts = {}) {
  const home = opts.home || os.homedir();
  if (target === "hermes") {
    const env = process.env.HERMES_HOME && process.env.HERMES_HOME.trim();
    const dir = opts.dir || env || path.join(home, ".hermes");
    return [{ file: path.join(dir, "SOUL.md"), part: "identity" }];
  }
  if (target === "openclaw") {
    const dir = opts.dir || path.join(home, ".openclaw", "workspace");
    return [
      { file: path.join(dir, "AGENTS.md"), part: "role" },
      { file: path.join(dir, "SOUL.md"), part: "tone" },
      { file: path.join(dir, "IDENTITY.md"), part: "card" },
    ];
  }
  return [];
}

// Files the runtime owns (we never write them) that an install can cause the
// runtime to delete, so install saves them and --remove restores them.
function sidecarsFor(target, opts = {}) {
  if (target !== "openclaw") return [];
  const dir = opts.dir || path.join(opts.home || os.homedir(), ".openclaw", "workspace");
  return [path.join(dir, "BOOTSTRAP.md")];
}

// Backups live outside the workspace (openclaw scans it), keyed by the
// absolute workspace path so named openclaw agents don't share a backup.
function backupPathFor(file, target, opts = {}) {
  const root = opts.home ? path.join(opts.home, ".openagent") : agentHome();
  const key = crypto.createHash("sha256").update(path.resolve(path.dirname(file))).digest("hex").slice(0, 16);
  return path.join(root, "backups", target, key, path.basename(file));
}

function copyKeepMode(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const mode = fs.statSync(from).mode & 0o777;
  const tmp = `${to}.openagent-${process.pid}.tmp`;
  fs.copyFileSync(from, tmp);
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, to);
}

// Install: save each sidecar that is present. Remove: restore each one that is
// missing and has a backup, then drop the backup (a later --remove must not
// resurrect a file the runtime removed on its own after we left).
function handleSidecars(target, opts) {
  const out = [];
  for (const file of sidecarsFor(target, opts)) {
    const bak = backupPathFor(file, target, opts);
    const present = fs.existsSync(file);
    const saved = fs.existsSync(bak);
    let action = null;
    if (!opts.remove) {
      if (present) action = "saved";
    } else if (saved) {
      action = present ? "kept" : "restored";
    }
    if (!action) continue;
    out.push({ file, part: "bootstrap", backup: bak, existed: present, action: opts.dryRun ? `would-be-${action}` : action });
    if (opts.dryRun) continue;
    if (action === "saved") copyKeepMode(file, bak);
    else {
      if (action === "restored") copyKeepMode(bak, file);
      fs.unlinkSync(bak);
    }
  }
  return out;
}

const str = (v) => (typeof v === "string" ? v.trim() : "");

// The precedence line matters because our block sits directly above the
// runtime's own default persona ("You are Hermes..."). Without it the model
// sees two identities and nothing saying which one wins.
function precedence(p) {
  return `This is your identity. It replaces any default assistant persona that follows in this file: when anyone asks who you are, you are ${p.name}, not the default assistant.`;
}

function reportingLines(p) {
  const org = p.org && typeof p.org === "object" ? p.org : null;
  if (!org || !str(org.name)) return [];
  return ["## Who you work for", `You are part of ${str(org.name)}${str(org.url) ? ` (${str(org.url)})` : ""}.`, ""];
}

function toneLines(p) {
  const voice = p.voice && typeof p.voice === "object" ? p.voice : {};
  const written = voice.written && typeof voice.written === "object" ? voice.written : {};
  const audio = voice.audio && typeof voice.audio === "object" ? voice.audio : {};
  const out = [];
  const rules = Array.isArray(written.rules) ? written.rules.filter((r) => str(r)) : [];
  if (rules.length) out.push("## How you write", ...rules.map((r) => `- ${str(r)}`), "");
  if (str(written.sample)) out.push(`Sample line in your voice: "${str(written.sample)}"`, "");
  if (str(audio.base) && audio.base !== "unset") {
    out.push("## Voice (audio)", `Base: ${str(audio.base)}${str(audio.style) ? ` — ${str(audio.style)}` : ""}`, "");
  }
  return out;
}

function lookLines(p) {
  const face = p.face && typeof p.face === "object" ? p.face : {};
  if (!str(face.anchor)) return [];
  // A local face.ref is relative to the persona file, which the runtime never
  // sees, so only a URL is worth handing to the model.
  const portrait = /^https?:/.test(str(face.ref)) ? [`Portrait: ${str(face.ref)}`] : [];
  return ["## Look", str(face.anchor), ...portrait, ""];
}

function topicLines(p) {
  const posts = Array.isArray(p.posts_about) ? p.posts_about.filter((x) => str(x)) : [];
  return posts.length ? ["## You speak to", posts.map(str).join(", "), ""] : [];
}

function linkLines(p) {
  const links = p.links && typeof p.links === "object" ? p.links : {};
  const keys = Object.keys(links).filter((k) => str(links[k]));
  return keys.length ? ["## Links", ...keys.map((k) => `- ${k}: ${str(links[k])}`), ""] : [];
}

function footer(p) {
  return `Installed from an OpenAgent persona (id: \`${p.id}\`, spec ${p.openagent || "0.1"}). Identity standard: github.com/5dive-ai/openagent`;
}

function header(p) {
  return [`# ${p.name}`, "", `You are **${p.name}**, ${p.role}.`, "", precedence(p), "", str(p.behavior), ""];
}

// One renderer per slot part. `identity` is the whole persona in one doc —
// the same shape the CLI's _persona_render_claudemd writes for a 5dive seat.
function renderPart(p, part) {
  let lines;
  if (part === "identity") {
    lines = [...header(p), ...reportingLines(p), ...toneLines(p), ...lookLines(p), ...topicLines(p), ...linkLines(p)];
  } else if (part === "role") {
    // AGENTS.md is openclaw's operating-instructions slot: role + reporting.
    lines = [...header(p), ...reportingLines(p), ...topicLines(p), ...linkLines(p)];
  } else if (part === "tone") {
    // SOUL.md is openclaw's persona/tone slot.
    lines = [`# ${p.name} — voice`, "", ...toneLines(p), ...lookLines(p)];
    if (lines.length === 2) lines.push(str(p.behavior), "");
  } else if (part === "card") {
    const face = p.face && typeof p.face === "object" ? p.face : {};
    lines = [
      `# IDENTITY.md - ${p.name}`,
      "",
      `- **Name:** ${p.name}`,
      `- **Creature:** ${p.role}`,
      `- **Vibe:** ${str(p.behavior)}`,
    ];
    if (str(face.ref) && /^(https?:|data:)/.test(str(face.ref))) lines.push(`- **Avatar:** ${str(face.ref)}`);
    lines.push("");
  } else {
    throw new Error(`unknown slot part: ${part}`);
  }
  lines.push(footer(p));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function stripBlocks(text) {
  return String(text || "").replace(BLOCK_RE, "");
}

function wrapBlock(p, body) {
  return `${BEGIN(p.id)}\n${body}\n${END}\n`;
}

// Prepend (or replace) our block on top of whatever the runtime wrote. Any
// earlier openagent block goes first, so one runtime carries one identity.
function prependBlock(existing, p, body) {
  const rest = stripBlocks(existing);
  const block = wrapBlock(p, body);
  return rest.length ? `${block}\n${rest}` : block;
}

function readOr(file, def) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return def;
    throw e;
  }
}

// Atomic write that keeps an existing file's mode.
function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = 0o644;
  try { mode = fs.statSync(file).mode & 0o777; } catch (_) { /* new file */ }
  const tmp = `${file}.openagent-${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
}

// Install (or with remove: uninstall) a persona into a runtime's slots.
// Returns { slots: [{ file, part, action, existed }] } where action is one of
// "prepended" | "replaced" | "created" | "removed" | "absent" | "would-*".
function installPersona(persona, target, opts = {}) {
  const slots = slotsFor(target, opts);
  if (!slots.length) throw new Error(`no slot map for runtime '${target}'`);
  const results = [];
  for (const s of slots) {
    const before = readOr(s.file, null);
    const existed = before !== null;
    const hadBlock = existed && stripBlocks(before) !== before;
    let after, action;
    if (opts.remove) {
      if (!hadBlock) {
        results.push({ ...s, existed, action: "absent" });
        continue;
      }
      after = stripBlocks(before);
      action = "removed";
    } else {
      after = prependBlock(before || "", persona, renderPart(persona, s.part));
      action = !existed ? "created" : hadBlock ? "replaced" : "prepended";
    }
    if (opts.dryRun) {
      results.push({ ...s, existed, action: `would-${action}`, content: after });
      continue;
    }
    if (opts.remove && after.length === 0) fs.unlinkSync(s.file);
    else writeAtomic(s.file, after);
    results.push({ ...s, existed, action });
  }
  return { slots: results, sidecars: handleSidecars(target, opts) };
}

// `--to=5dive`: no file to write. On a 5dive box the CLI hires the agent from
// the persona; anywhere else, point at where to get a box. Plain paths, no
// query strings (the persona is too big for a URL and the page reads none).
function fiveDivePlan(personaFile, persona, opts = {}) {
  const abs = path.resolve(personaFile);
  const name = opts.as || persona.id;
  const argv = ["agent", "import", `--from-persona=${abs}`, `--as=${name}`];
  return {
    onBox: Boolean(opts.fiveDiveBin),
    bin: opts.fiveDiveBin || "5dive",
    argv,
    command: `5dive ${argv.map(shellQuote).join(" ")}`,
    // 5dive.ai/openagent is DIVE-6138's page and 404s until it ships.
    signup: "https://5dive.ai",
  };
}

function shellQuote(s) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`;
}

// Find the 5dive CLI on PATH without spawning a shell.
function findOnPath(bin, envPath = process.env.PATH || "") {
  for (const d of envPath.split(path.delimiter)) {
    if (!d) continue;
    const f = path.join(d, bin);
    try {
      fs.accessSync(f, fs.constants.X_OK);
      if (fs.statSync(f).isFile()) return f;
    } catch (_) { /* keep looking */ }
  }
  return null;
}

module.exports = {
  TARGETS,
  slotsFor,
  sidecarsFor,
  backupPathFor,
  renderPart,
  stripBlocks,
  prependBlock,
  installPersona,
  fiveDivePlan,
  findOnPath,
};
