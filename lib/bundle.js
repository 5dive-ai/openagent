"use strict";

// Agent bundles (SPEC.md §Agent bundle): one agent.tar.gz that carries an agent
// from one harness to another. Its persona, its skills and, if you ask, its
// memory files.
//
//   exportBundle(from, opts) -> { buffer, manifest, notes }
//   readBundle(buffer)       -> { manifest, persona, files }   (verified, or throws)
//   importBundle(buffer, to, opts) -> { persona, skills, memory, notes }
//
// Plain copy only: no distillation, no LLM, no network. The 5dive CLI writes and
// reads the same format (`5dive agent export --format=pack` / `agent import`)
// and adds its own manifest keys on top, which this file keeps but never reads.
//
// Where each harness keeps the three parts. The persona slots come from
// lib/install.js; skills and memory are below. `dir` replaces the harness's own
// directory (~/.hermes, ~/.openclaw/workspace, ~/.claude, ~/.codex) the way
// `install --dir` does. `home` replaces $HOME (tests).
//
//                skills                          memory
//   hermes       ~/.hermes/skills                ~/.hermes/memories/*.md
//   openclaw     ~/.openclaw/workspace/skills    workspace MEMORY.md + workspace/memory/*.md
//   claude-code  ~/.claude/skills                ~/.claude/projects/<project slug>/memory/*.md
//   codex        ~/.codex/skills                 ~/.codex/memories/*.md
//
// A harness's own files are never overwritten: a skill or memory file that is
// already there with other content stops the import before anything is written,
// unless `overwrite` is set. The persona is prepended, as `install` does.
//
// The persona slot holds a RENDERED block, not the persona file, so export needs
// the file itself. Install and import keep a copy under
// ~/.openagent/agents/<harness>/<dir key>/<id>/ (outside the harness's own dir:
// openclaw scans its workspace), along with any bundle members and manifest keys
// openagent does not own (5dive's CLAUDE.md, avatar.png, packFormat, ...). So an
// agent that passes through a harness comes back out whole.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const YAML = require("yaml");
const tar = require("./tar");
const { SECRET_RE } = require("./leak-guard");
const { validateDoc } = require("./validate");
const { slotsFor, runtimeDirFor, installPersona, TARGET_NAMES } = require("./install");
const { agentHome } = require("./keystore");

const BUNDLE_VERSION = 1;
const HARNESSES = ["hermes", "openclaw", "claude-code", "codex"];
// The manifest keys this spec defines. Every other top-level key belongs to the
// tool that wrote it (5dive: packFormat, agentName, config, ...) and is kept.
const OWN_KEYS = new Set(["bundle_version", "openagent", "source_harness", "created_at", "persona", "files"]);
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_FILE = 10 * 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules"]);

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const toolVersion = () => require("../package.json").version;

// ---- where things live -------------------------------------------------------

function homeOf(opts) {
  return opts.home || os.homedir();
}

// Claude Code keys a project's memory by its absolute path with every
// non-alphanumeric character turned into "-" (/home/me/app -> -home-me-app).
function projectSlug(project) {
  return path.resolve(project).replace(/[^A-Za-z0-9]/g, "-");
}

function skillsDirs(h, opts = {}) {
  const home = homeOf(opts);
  const own = runtimeDirFor(h, opts);
  if (h === "hermes") return { write: path.join(own, "skills"), read: [path.join(own, "skills")], depth: 2 };
  if (h === "openclaw") {
    const read = [path.join(own, "skills")];
    if (!opts.dir) read.push(path.join(home, ".openclaw", "skills"));
    return { write: read[0], read, depth: 1 };
  }
  if (h === "claude-code") return { write: path.join(own, "skills"), read: [path.join(own, "skills")], depth: 1 };
  if (h === "codex") {
    const read = [path.join(own, "skills")];
    // Codex also scans ~/.agents/skills, where `npx skills` puts them.
    if (!opts.dir) read.push(path.join(home, ".agents", "skills"));
    return { write: read[0], read, depth: 1 };
  }
  throw new Error(`no skills dir known for '${h}'`);
}

// { dir, index }: memory files are dir/*.md; `index` is a file outside dir that
// travels as memory/MEMORY.md (openclaw keeps MEMORY.md at the workspace root).
function memoryDir(h, opts = {}) {
  const own = runtimeDirFor(h, opts);
  if (h === "hermes") return { dir: path.join(own, "memories") };
  if (h === "openclaw") return { dir: path.join(own, "memory"), index: path.join(own, "MEMORY.md") };
  if (h === "claude-code") return { dir: path.join(own, "projects", projectSlug(opts.project || process.cwd()), "memory") };
  if (h === "codex") return { dir: path.join(own, "memories") };
  return null;
}

function storeRoot(h, opts = {}) {
  const root = opts.home ? path.join(opts.home, ".openagent") : agentHome();
  const key = crypto.createHash("sha256").update(path.resolve(runtimeDirFor(h, opts))).digest("hex").slice(0, 16);
  return path.join(root, "agents", h, key);
}

// ---- secrets -----------------------------------------------------------------

// `token: <your token>` and `password = getPassword()` are how docs and code
// talk about secrets, not secrets. The assignment form only counts when the
// value looks like one: 12+ characters with a digit, not a placeholder.
const ASSIGN = /^(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*(\S+)/i;
const PLACEHOLDER = /^["'`]?(?:[<{[$%(]|your|my[-_]|example|sample|dummy|placeholder|xxx|\*{3}|\.{3}|changeme|redacted|null|none|true|false|process\.env|os\.environ|env\.|getenv)/i;

function secretHits(data, file) {
  if (data.includes(0)) return []; // binary (an avatar): no text to read
  const hits = [];
  const g = new RegExp(SECRET_RE.source, "gi");
  data.toString("utf8").split("\n").forEach((line, i) => {
    for (const m of line.matchAll(g)) {
      const a = ASSIGN.exec(m[0]);
      if (a) {
        const v = a[1].replace(/^["'`]|["'`,;]+$/g, "");
        if (PLACEHOLDER.test(a[1]) || v.length < 12 || !/\d/.test(v)) continue;
      }
      // Never the value itself: the refusal must not become the leak.
      hits.push(`${file}:${i + 1}`);
      break;
    }
  });
  return hits;
}

function refuseSecrets(files, verb) {
  const hits = [];
  for (const f of files) hits.push(...secretHits(f.data, f.path));
  if (hits.length) {
    const e = new Error(
      `${verb} refused: a secret-shaped string (API key, token, private key or password) is in ${hits.join(", ")}. ` +
        "A bundle never carries secrets: remove it, then retry."
    );
    e.code = "SECRET";
    e.hits = hits;
    throw e;
  }
}

// ---- reading a harness -------------------------------------------------------

function readFileOr(file) {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// Every regular file under dir, relative paths sorted. A skill dir that is a
// symlink is followed (`npx skills` links them in); a symlink INSIDE a skill is
// skipped and noted, so a bundle never carries a file from outside the skill.
function walk(dir, notes, label) {
  const out = [];
  (function rec(abs, rel) {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      const p = path.join(abs, ent.name);
      if (ent.isSymbolicLink()) { notes.push(`skipped ${label}/${r}: a symlink`); continue; }
      if (ent.isDirectory()) { if (!SKIP_DIRS.has(ent.name)) rec(p, r); continue; }
      if (!ent.isFile()) continue;
      const st = fs.statSync(p);
      if (st.size > MAX_FILE) { notes.push(`skipped ${label}/${r}: over 10 MB`); continue; }
      out.push({ rel: r, data: fs.readFileSync(p) });
    }
  })(dir, "");
  return out;
}

function readSkills(h, opts, notes) {
  const { read, depth } = skillsDirs(h, opts);
  const seen = new Map();
  for (const root of read) {
    if (!isDir(root)) continue;
    const candidates = [];
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      const p = path.join(root, ent.name);
      if (ent.name.startsWith(".") || !isDir(p)) continue;
      if (fs.existsSync(path.join(p, "SKILL.md"))) candidates.push({ name: ent.name, dir: p });
      else if (depth > 1) {
        // hermes groups skills by category: skills/<category>/<name>/SKILL.md
        for (const sub of fs.readdirSync(p, { withFileTypes: true })) {
          const sp = path.join(p, sub.name);
          if (!sub.name.startsWith(".") && isDir(sp) && fs.existsSync(path.join(sp, "SKILL.md"))) candidates.push({ name: sub.name, dir: sp });
        }
      }
    }
    for (const c of candidates.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!SKILL_NAME.test(c.name)) { notes.push(`skipped skill '${c.name}': not a portable skill name`); continue; }
      if (seen.has(c.name)) { notes.push(`skipped ${c.dir}: a skill named '${c.name}' was already read from ${seen.get(c.name).dir}`); continue; }
      seen.set(c.name, { dir: c.dir, files: walk(c.dir, notes, `skills/${c.name}`) });
    }
  }
  return seen;
}

function readMemory(h, opts, notes) {
  const m = memoryDir(h, opts);
  const out = new Map();
  if (isDir(m.dir)) {
    for (const ent of fs.readdirSync(m.dir, { withFileTypes: true })) {
      if (ent.isFile() && ent.name.endsWith(".md")) out.set(ent.name, fs.readFileSync(path.join(m.dir, ent.name)));
      else if (ent.isDirectory()) notes.push(`skipped memory subdirectory ${path.join(m.dir, ent.name)}: a bundle's memory is flat`);
    }
  }
  if (m.index) {
    const idx = readFileOr(m.index);
    if (idx) {
      if (out.has("MEMORY.md")) notes.push(`${path.join(m.dir, "MEMORY.md")} skipped: ${m.index} is the index that travels`);
      out.set("MEMORY.md", idx);
    }
  }
  return { files: out, where: m };
}

// The id of the openagent persona installed in a harness, from our block's marker.
function installedId(h, opts) {
  const slot = slotsFor(h, opts)[0];
  const text = readFileOr(slot.file);
  const m = text && /<!-- openagent:begin id=(\S+)/.exec(text.toString("utf8"));
  return m ? m[1] : null;
}

// What install/import kept for <id> in this harness: { personaName, persona, extras, ext }.
function readStore(h, opts, id) {
  const dir = path.join(storeRoot(h, opts), id);
  if (!isDir(dir)) return null;
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, "store.json"), "utf8")); } catch { return null; }
  const persona = readFileOr(path.join(dir, "persona", meta.persona || ""));
  if (!persona) return null;
  const extrasDir = path.join(dir, "extras");
  const extras = isDir(extrasDir) ? walk(extrasDir, [], "extras").map((f) => ({ path: f.rel, data: f.data })) : [];
  return { personaName: meta.persona, persona, extras, ext: meta.ext || {} };
}

// Keep the persona file (and what openagent does not own) beside the harness, so
// `export` can hand back the file and not just the block rendered from it.
function rememberPersona(h, opts, { personaName, persona, extras = [], ext = {} }) {
  const doc = YAML.parse(persona.toString("utf8"));
  const dir = path.join(storeRoot(h, opts), String(doc.id));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "persona"), { recursive: true });
  fs.writeFileSync(path.join(dir, "persona", personaName), persona);
  for (const f of extras) {
    const p = path.join(dir, "extras", f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.data);
  }
  fs.writeFileSync(path.join(dir, "store.json"), JSON.stringify({ persona: personaName, ext }, null, 2) + "\n");
  return dir;
}

function parsePersona(buf, label) {
  let doc;
  try {
    doc = YAML.parse(buf.toString("utf8"));
  } catch (e) {
    throw new Error(`${label} is not valid YAML: ${e.message}`);
  }
  const v = validateDoc(doc);
  if (!v.ok) throw new Error(`${label} is not a valid OpenAgent persona: ${v.errors.join("; ")}`);
  return doc;
}

// ---- export ------------------------------------------------------------------

// opts: { home, dir, project, persona: <file>, memory: bool, skills: bool (default true), now: Date }
function exportBundle(from, opts = {}) {
  if (!HARNESSES.includes(from)) throw new Error(`export: --from must be one of ${HARNESSES.join(", ")}`);
  const notes = [];
  let personaName, personaBuf, extras = [], ext = {};
  if (opts.persona) {
    personaBuf = fs.readFileSync(opts.persona);
    personaName = path.basename(opts.persona);
  } else {
    const id = installedId(from, opts);
    if (!id) {
      throw new Error(`no OpenAgent persona is installed in ${TARGET_NAMES[from]} (${slotsFor(from, opts)[0].file}). Install one with \`openagent install --to=${from}\`, or name the file with --persona=<file>.`);
    }
    const kept = readStore(from, opts, id);
    if (kept) ({ personaName, persona: personaBuf, extras, ext } = kept);
    else {
      // Installed before 0.51, which kept no copy: init's own copy, if it is this agent.
      const own = readFileOr(path.join(opts.home ? path.join(opts.home, ".openagent") : agentHome(), "persona.yaml"));
      let ownId = null;
      try { ownId = own && YAML.parse(own.toString("utf8")).id; } catch { /* not ours */ }
      if (ownId !== id) {
        throw new Error(`${TARGET_NAMES[from]} has persona '${id}' installed, but openagent kept no copy of its file (it was installed before 0.51). Name it with --persona=<file>.`);
      }
      personaBuf = own;
      personaName = `${id}.persona.yaml`;
    }
  }
  const persona = parsePersona(personaBuf, personaName);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/.test(personaName) || personaName.includes("/")) personaName = `${persona.id}.persona.yaml`;

  const files = new Map([[personaName, personaBuf]]);
  if (opts.skills !== false) {
    for (const [name, s] of readSkills(from, opts, notes)) {
      for (const f of s.files) files.set(`skills/${name}/${f.rel}`, f.data);
    }
  }
  if (opts.memory) {
    const mem = readMemory(from, opts, notes);
    if (!mem.files.size) notes.push(`no memory files in ${mem.where.dir}${mem.where.index ? ` or ${mem.where.index}` : ""}`);
    for (const [n, d] of [...mem.files].sort((a, b) => (a[0] < b[0] ? -1 : 1))) files.set(`memory/${n}`, d);
  }
  for (const f of extras) {
    if (files.has(f.path) || f.path === "manifest.json" || f.path.startsWith("skills/") || f.path.startsWith("memory/")) continue;
    files.set(f.path, f.data);
  }
  return writeBundle(files, { personaName, source: from, ext, now: opts.now, notes });
}

// The writer both `export` and the tests use. files: Map(path -> Buffer).
function writeBundle(files, { personaName, source, ext = {}, now, notes = [] }) {
  const entries = [...files].map(([p, data]) => ({ path: tar.cleanPath(p), data })).sort((a, b) => (a.path < b.path ? -1 : 1));
  refuseSecrets(entries, "export");
  const created = (now || new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const manifest = {
    bundle_version: BUNDLE_VERSION,
    openagent: toolVersion(),
    source_harness: source,
    created_at: created,
    persona: personaName,
    files: Object.fromEntries(entries.map((e) => [e.path, sha256(e.data)])),
  };
  for (const [k, v] of Object.entries(ext)) if (!OWN_KEYS.has(k)) manifest[k] = v;
  const mbuf = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  refuseSecrets([{ path: "manifest.json", data: mbuf }], "export");
  const buffer = tar.pack([{ path: "manifest.json", data: mbuf }, ...entries], { mtime: Date.parse(created) / 1000 });
  return { buffer, manifest, notes };
}

// ---- reading a bundle --------------------------------------------------------

function readBundle(buffer) {
  let members;
  try {
    members = tar.unpack(buffer, { maxFile: MAX_FILE });
  } catch (e) {
    throw new Error(`not an agent bundle: ${e.message}`);
  }
  const byPath = new Map(members.map((m) => [m.path, m.data]));
  const mbuf = byPath.get("manifest.json");
  if (!mbuf) throw new Error("not an agent bundle: no manifest.json");
  let manifest;
  try { manifest = JSON.parse(mbuf.toString("utf8")); } catch (e) { throw new Error(`manifest.json is not JSON: ${e.message}`); }
  if (!Number.isInteger(manifest.bundle_version)) {
    throw new Error(
      manifest.packFormat
        ? "this is a 5dive pack from before bundles (no bundle_version): re-export it with a current 5dive CLI, or import it with `5dive agent import`"
        : "manifest.json has no bundle_version: not an OpenAgent agent bundle"
    );
  }
  if (manifest.bundle_version > BUNDLE_VERSION) {
    throw new Error(`bundle version ${manifest.bundle_version} is newer than this openagent reads (${BUNDLE_VERSION}): upgrade openagent`);
  }
  const listed = manifest.files && typeof manifest.files === "object" ? manifest.files : null;
  if (!listed) throw new Error("manifest.json has no files list");
  const problems = [];
  for (const [p, want] of Object.entries(listed)) {
    const d = byPath.get(p);
    if (!d) problems.push(`${p} is listed but missing`);
    else if (sha256(d) !== want) problems.push(`${p} does not match its sha256`);
  }
  for (const p of byPath.keys()) if (p !== "manifest.json" && !(p in listed)) problems.push(`${p} is not in the manifest`);
  if (problems.length) throw new Error(`bundle failed its integrity check: ${problems.join("; ")}`);
  const personaName = manifest.persona;
  if (typeof personaName !== "string" || personaName.includes("/") || !byPath.has(personaName)) {
    throw new Error("manifest.json names no persona file the bundle carries");
  }
  refuseSecrets(members, "import");
  const persona = parsePersona(byPath.get(personaName), personaName);
  const files = members.filter((m) => m.path !== "manifest.json");
  return { manifest, persona, personaName, files };
}

// ---- import ------------------------------------------------------------------

function sameTree(dir, files) {
  if (!isDir(dir)) return false;
  const have = walk(dir, [], "");
  if (have.length !== files.length) return false;
  const want = new Map(files.map((f) => [f.rel, f.data]));
  return have.every((f) => want.has(f.rel) && want.get(f.rel).equals(f.data));
}

// opts: { home, dir, project, overwrite, dryRun }
function importBundle(buffer, to, opts = {}) {
  if (!HARNESSES.includes(to)) throw new Error(`import: --to must be one of ${HARNESSES.join(", ")}, or 5dive`);
  const b = readBundle(buffer);
  const notes = [];
  const skills = new Map(), memory = new Map(), extras = [];
  for (const f of b.files) {
    const parts = f.path.split("/");
    if (parts[0] === "skills" && parts.length >= 3) {
      if (!SKILL_NAME.test(parts[1])) throw new Error(`bundle skill name '${parts[1]}' is not a portable skill name`);
      if (!skills.has(parts[1])) skills.set(parts[1], []);
      skills.get(parts[1]).push({ rel: parts.slice(2).join("/"), data: f.data });
    } else if (parts[0] === "memory" && parts.length === 2 && parts[1].endsWith(".md")) {
      memory.set(parts[1], f.data);
    } else if (f.path !== b.personaName) {
      extras.push(f);
    }
  }
  for (const [name, fs_] of skills) if (!fs_.some((f) => f.rel === "SKILL.md")) throw new Error(`bundle skill '${name}' has no SKILL.md`);

  // Plan every write, and stop on any clash before the first one.
  const sdir = skillsDirs(to, opts).write;
  const mem = memoryDir(to, opts);
  const plan = { skills: [], memory: [] }, clashes = [];
  for (const [name, files] of [...skills].sort()) {
    const dest = path.join(sdir, name);
    const action = !fs.existsSync(dest) ? "created" : sameTree(dest, files) ? "unchanged" : "replaced";
    if (action === "replaced" && !opts.overwrite) clashes.push(`${dest} (a different skill '${name}' is there)`);
    plan.skills.push({ name, dest, files, action });
  }
  for (const [name, data] of [...memory].sort()) {
    const dest = name === "MEMORY.md" && mem.index ? mem.index : path.join(mem.dir, name);
    const cur = readFileOr(dest);
    const action = cur === null ? "created" : cur.equals(data) ? "unchanged" : "replaced";
    if (action === "replaced" && !opts.overwrite) clashes.push(`${dest} (holds other content)`);
    plan.memory.push({ name, dest, data, action });
  }
  if (clashes.length) {
    const e = new Error(`import refused, nothing written: ${clashes.join("; ")}. Re-run with --overwrite to replace them.`);
    e.code = "CLASH";
    throw e;
  }
  if (extras.length) notes.push(`kept ${extras.map((f) => f.path).join(", ")} beside the persona (not a ${TARGET_NAMES[to]} file; a later export carries it on)`);

  const ext = Object.fromEntries(Object.entries(b.manifest).filter(([k]) => !OWN_KEYS.has(k)));
  const personaBuf = b.files.find((f) => f.path === b.personaName).data;
  if (opts.dryRun) {
    return { manifest: b.manifest, persona: { id: b.persona.id, name: b.persona.name, slots: slotsFor(to, opts).map((s) => ({ file: s.file, action: "would-install" })) }, skills: plan.skills.map((s) => ({ ...s, action: `would-be-${s.action}`, files: undefined })), memory: plan.memory.map((m) => ({ ...m, data: undefined, action: `would-be-${m.action}` })), notes };
  }

  const installed = installPersona(b.persona, to, opts);
  rememberPersona(to, opts, { personaName: b.personaName, persona: personaBuf, extras, ext });
  for (const s of plan.skills) {
    if (s.action === "unchanged") continue;
    fs.rmSync(s.dest, { recursive: true, force: true });
    for (const f of s.files) {
      const p = path.join(s.dest, f.rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, f.data);
    }
  }
  for (const m of plan.memory) {
    if (m.action === "unchanged") continue;
    fs.mkdirSync(path.dirname(m.dest), { recursive: true });
    fs.writeFileSync(m.dest, m.data);
  }
  return {
    manifest: b.manifest,
    persona: { id: b.persona.id, name: b.persona.name, slots: installed.slots.map((s) => ({ file: s.file, action: s.action })) },
    skills: plan.skills.map(({ name, dest, action }) => ({ name, dest, action })),
    memory: plan.memory.map(({ name, dest, action }) => ({ name, dest, action })),
    notes,
  };
}

module.exports = {
  BUNDLE_VERSION,
  HARNESSES,
  exportBundle,
  writeBundle,
  readBundle,
  importBundle,
  rememberPersona,
  skillsDirs,
  memoryDir,
  projectSlug,
  secretHits,
};
