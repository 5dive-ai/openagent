"use strict";

// `openagent export` / `openagent import` and lib/bundle.js (DIVE-6202). Every
// arm runs against a temp $HOME, never the real one.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const YAML = require("yaml");
const bundle = require("../lib/bundle");
const tar = require("../lib/tar");

const CLI = path.join(__dirname, "..", "bin", "openagent.js");
let pass = 0;
const fail = [];
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail.push(`${name}: ${e.message}`);
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "oa-bundle-"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
for (const k of ["HERMES_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENAGENT_HOME"]) delete process.env[k];

const QUILL = {
  openagent: "0.2",
  id: "quill",
  name: "Quill",
  role: "Release Archivist",
  behavior: "Keeps the changelog honest.",
  face: { anchor: "a tidy owl in reading glasses", ref: "https://example.com/quill.png" },
  voice: { written: { rules: ["short sentences"], sample: "Shipped. Logged." } },
};
const QUILL_YAML = YAML.stringify(QUILL);

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// Every file under dir as { rel: sha }, for tree diffs.
function tree(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  (function rec(abs, rel) {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) rec(path.join(abs, e.name), r);
      else out[r] = sha(fs.readFileSync(path.join(abs, e.name)));
    }
  })(dir, "");
  return out;
}

function run(args, { home, cwd } = {}) {
  const env = { ...process.env, HOME: home, OPENAGENT_HOME: path.join(home, ".openagent"), NO_COLOR: "1", OPENAGENT_NO_PUBLISH: "1" };
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: cwd || home, env, encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

// An openclaw home the way a user has it: openclaw's own workspace files, our
// persona installed, two skills (one with a helper script), a MEMORY.md and
// two daily notes.
function openclawAgent() {
  const home = tmp();
  const ws = path.join(home, ".openclaw", "workspace");
  write(path.join(ws, "AGENTS.md"), "# AGENTS.md - Your Workspace\n\nThis folder is home.\n");
  write(path.join(home, "quill.persona.yaml"), QUILL_YAML);
  const r = run(["install", "--to=openclaw", path.join(home, "quill.persona.yaml")], { home });
  assert.strictEqual(r.code, 0, r.out);
  write(path.join(ws, "skills", "changelog", "SKILL.md"), "---\nname: changelog\ndescription: Write the changelog\n---\nRead the merged PRs, write one line each.\n");
  write(path.join(ws, "skills", "changelog", "scripts", "collect.sh"), "#!/bin/sh\ngit log --oneline \"$1\"..HEAD\n");
  write(path.join(ws, "skills", "release-notes", "SKILL.md"), "---\nname: release-notes\ndescription: Notes for a release\n---\nGroup by area.\n");
  write(path.join(ws, "MEMORY.md"), "# Memory\n\n- [Versioning](versioning.md) - semver, minors for features\n");
  write(path.join(ws, "memory", "versioning.md"), "---\nname: versioning\ndescription: semver\nmetadata:\n  type: project\n---\nMinors for features, patches for fixes.\n");
  write(path.join(ws, "memory", "2026-10-13.md"), "Cut 0.49.2 today.\n");
  return { home, ws };
}

console.log("bundle: openclaw -> agent.tar.gz -> hermes");

t("openclaw -> export -> import --to=hermes keeps persona, skills and memory files (tree diff)", () => {
  const { home, ws } = openclawAgent();
  const out = path.join(home, "quill.tar.gz");
  const ex = run(["export", "--from=openclaw", "--memory", "-o", out], { home });
  assert.strictEqual(ex.code, 0, ex.out);
  assert.match(ex.out, /skills\s+2/);
  assert.match(ex.out, /memory\s+3 file/);

  const hermes = tmp();
  write(path.join(hermes, ".hermes", "SOUL.md"), "You are Hermes Agent, an intelligent AI assistant created by Nous Research.\n");
  const im = run(["import", out, "--to=hermes"], { home: hermes });
  assert.strictEqual(im.code, 0, im.out);

  // Skills: the same trees, file for file.
  assert.deepStrictEqual(tree(path.join(hermes, ".hermes", "skills")), tree(path.join(ws, "skills")));
  // Memory: every file openclaw had, byte for byte (MEMORY.md from the workspace root).
  const mem = tree(path.join(hermes, ".hermes", "memories"));
  assert.deepStrictEqual(mem, { ...tree(path.join(ws, "memory")), "MEMORY.md": sha(fs.readFileSync(path.join(ws, "MEMORY.md"))) });
  // Persona: hermes answers as Quill, above its own default, and kept the file.
  const soul = fs.readFileSync(path.join(hermes, ".hermes", "SOUL.md"), "utf8");
  assert.match(soul, /^<!-- openagent:begin id=quill/);
  assert.match(soul, /You are \*\*Quill\*\*, Release Archivist/);
  assert.match(soul, /You are Hermes Agent/);

  // And back out of hermes: the same bundle members.
  const again = run(["export", "--from=hermes", "--memory", "-o", path.join(hermes, "again.tar.gz")], { home: hermes });
  assert.strictEqual(again.code, 0, again.out);
  const a = bundle.readBundle(fs.readFileSync(out)), b = bundle.readBundle(fs.readFileSync(path.join(hermes, "again.tar.gz")));
  assert.deepStrictEqual(b.manifest.files, a.manifest.files);
  assert.strictEqual(a.manifest.source_harness, "openclaw");
  assert.strictEqual(b.manifest.source_harness, "hermes");
});

t("the manifest names its version, source, time, persona and a sha256 per file", () => {
  const { home } = openclawAgent();
  const r = bundle.exportBundle("openclaw", { home, memory: true, now: new Date("2026-10-14T05:00:00.123Z") });
  const m = r.manifest;
  assert.strictEqual(m.bundle_version, 1);
  assert.strictEqual(m.openagent, require("../package.json").version);
  assert.strictEqual(m.source_harness, "openclaw");
  assert.strictEqual(m.created_at, "2026-10-14T05:00:00Z");
  assert.strictEqual(m.persona, "quill.persona.yaml");
  assert.deepStrictEqual(Object.keys(m.files).sort(), [
    "memory/2026-10-13.md", "memory/MEMORY.md", "memory/versioning.md", "quill.persona.yaml",
    "skills/changelog/SKILL.md", "skills/changelog/scripts/collect.sh", "skills/release-notes/SKILL.md",
  ]);
  assert.strictEqual(m.files["quill.persona.yaml"], sha(Buffer.from(QUILL_YAML)));
  // The first member is the manifest; the persona file travels byte for byte.
  const members = tar.unpack(r.buffer);
  assert.strictEqual(members[0].path, "manifest.json");
  assert.strictEqual(members.find((x) => x.path === "quill.persona.yaml").data.toString(), QUILL_YAML);
});

t("the same agent exported twice at the same time is the same bytes", () => {
  const { home } = openclawAgent();
  const now = new Date("2026-10-14T05:00:00Z");
  const a = bundle.exportBundle("openclaw", { home, memory: true, now }).buffer;
  const b = bundle.exportBundle("openclaw", { home, memory: true, now }).buffer;
  assert.ok(a.equals(b));
});

t("memory stays out unless --memory", () => {
  const { home } = openclawAgent();
  const r = bundle.exportBundle("openclaw", { home });
  assert.ok(!Object.keys(r.manifest.files).some((p) => p.startsWith("memory/")));
});

console.log("bundle: the 5dive pack is the same format");

// A pack the way `5dive agent export --format=pack` writes it: GNU tar of a
// stage dir (./ prefixes, directory entries), persona.yaml, 5dive's own
// manifest keys and members (CLAUDE.md, avatar.png) next to the bundle's.
function fiveDivePack(dir, { secret } = {}) {
  const stage = path.join(dir, "stage");
  write(path.join(stage, "persona.yaml"), QUILL_YAML);
  write(path.join(stage, "CLAUDE.md"), "# Quill\n\nYou are Quill.\n");
  fs.writeFileSync(path.join(stage, "avatar.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d, 1, 2, 3]));
  write(path.join(stage, "memory", "MEMORY.md"), "# Memory Index\n\n- [release](release.md)\n");
  write(path.join(stage, "memory", "release.md"), "---\nname: release\nmetadata:\n  type: reference\n---\nTag after CI is green.\n" + (secret ? "api_key = sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345\n" : ""));
  write(path.join(stage, "skills", "changelog", "SKILL.md"), "---\nname: changelog\n---\nOne line per PR.\n");
  const files = {};
  for (const [rel, h] of Object.entries(tree(stage))) files[rel] = h;
  const manifest = {
    packFormat: 1, agentName: "quill", createdWith: "2026.10.14",
    includes: { memory: "distilled", memoryShape: "atoms", persona: true },
    config: { type: "claude", isolation: "standard" }, plugins: [], skills: ["changelog"], hooks: {},
    bundle_version: 1, openagent: "0.51.0", source_harness: "5dive", created_at: "2026-10-14T04:00:00Z",
    persona: "persona.yaml", files,
  };
  write(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const out = path.join(dir, "quill-pack.tar.gz");
  const r = spawnSync("tar", ["-czf", out, "-C", stage, "."]);
  assert.strictEqual(r.status, 0, String(r.stderr));
  return { out, stage, manifest };
}

t("a 5dive pack imports with openagent (GNU tar, ./ paths, directory entries)", () => {
  const dir = tmp();
  const { out } = fiveDivePack(dir);
  const home = tmp();
  const r = run(["import", out, "--to=claude-code", "--project", "/work/app"], { home });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8"), /You are \*\*Quill\*\*/);
  assert.ok(fs.existsSync(path.join(home, ".claude", "skills", "changelog", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(home, ".claude", "projects", "-work-app", "memory", "release.md")));
  assert.match(r.out, /kept avatar\.png, CLAUDE\.md beside the persona/);
});

t("a 5dive pack -> openagent import -> export round-trips byte for byte (all but the manifest's time and source)", () => {
  const dir = tmp();
  const { out } = fiveDivePack(dir);
  const home = tmp();
  assert.strictEqual(run(["import", out, "--to=hermes"], { home }).code, 0);
  const back = path.join(home, "back.tar.gz");
  const r = run(["export", "--from=hermes", "--memory", "-o", back], { home });
  assert.strictEqual(r.code, 0, r.out);
  const a = tar.unpack(fs.readFileSync(out)), b = tar.unpack(fs.readFileSync(back));
  const am = new Map(a.map((x) => [x.path, x.data])), bm = new Map(b.map((x) => [x.path, x.data]));
  assert.deepStrictEqual([...bm.keys()].sort(), [...am.keys()].sort());
  for (const [p, d] of am) if (p !== "manifest.json") assert.ok(d.equals(bm.get(p)), `${p} changed`);
  const ma = JSON.parse(am.get("manifest.json")), mb = JSON.parse(bm.get("manifest.json"));
  for (const k of ["created_at", "source_harness"]) { delete ma[k]; delete mb[k]; }
  assert.deepStrictEqual(mb, ma); // 5dive's own keys (packFormat, config, skills, ...) came back too
});

t("an openagent export carries what `5dive agent import` reads: persona, skills/<id>/SKILL.md, memory/*.md", () => {
  const { home } = openclawAgent();
  const r = bundle.exportBundle("openclaw", { home, memory: true });
  const names = tar.unpack(r.buffer).map((m) => m.path);
  assert.ok(names.includes("skills/changelog/SKILL.md"));
  assert.ok(names.includes("memory/versioning.md"));
  assert.strictEqual(r.manifest.persona, "quill.persona.yaml");
  assert.ok(!("packFormat" in r.manifest), "packFormat is 5dive's key, not ours");
});

t("a 5dive pack from before bundles is named as one", () => {
  const dir = tmp();
  write(path.join(dir, "s", "manifest.json"), JSON.stringify({ packFormat: 1, agentName: "x" }));
  write(path.join(dir, "s", "persona.yaml"), QUILL_YAML);
  spawnSync("tar", ["-czf", path.join(dir, "old.tar.gz"), "-C", path.join(dir, "s"), "."]);
  assert.throws(() => bundle.readBundle(fs.readFileSync(path.join(dir, "old.tar.gz"))), /5dive pack from before bundles/);
});

console.log("bundle: no secrets, no tampering, no clobbering");

t("a bundle with a fake API key is refused on export, naming file and line, not the key", () => {
  const { home, ws } = openclawAgent();
  write(path.join(ws, "memory", "creds.md"), "notes\nOPENAI key sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123\n");
  const r = run(["export", "--from=openclaw", "--memory", "-o", path.join(home, "x.tar.gz")], { home });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /refused.*memory\/creds\.md:2/);
  assert.doesNotMatch(r.out, /AbCdEfGh/);
  assert.ok(!fs.existsSync(path.join(home, "x.tar.gz")));
});

t("a bundle with a fake API key is refused on import, and nothing is written", () => {
  const dir = tmp();
  const { out } = fiveDivePack(dir, { secret: true });
  const home = tmp();
  const r = run(["import", out, "--to=hermes"], { home });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /refused.*memory\/release\.md:7/);
  assert.ok(!fs.existsSync(path.join(home, ".hermes")));
});

t("docs that talk about keys are not keys", () => {
  for (const line of ["token: <your token>", "api_key = os.environ['KEY']", "password = getPassword()", "secret: false", "set token=${TOKEN}"]) {
    assert.deepStrictEqual(bundle.secretHits(Buffer.from(line), "f"), [], line);
  }
  for (const line of ["ghp_AbCdEfGhIjKlMnOpQrStUvWxYz012345", "password: hunter2hunter22", "-----BEGIN OPENSSH PRIVATE KEY-----", "AKIAABCDEFGHIJKLMNOP"]) {
    assert.strictEqual(bundle.secretHits(Buffer.from(line), "f").length, 1, line);
  }
});

t("a member that does not match its sha256, or is not listed, is refused", () => {
  const { home } = openclawAgent();
  const r = bundle.exportBundle("openclaw", { home, memory: true });
  const members = tar.unpack(r.buffer);
  const edited = members.map((m) => (m.path === "skills/changelog/SKILL.md" ? { ...m, data: Buffer.from("rm -rf ~\n") } : m));
  assert.throws(() => bundle.readBundle(tar.pack(edited)), /skills\/changelog\/SKILL\.md does not match its sha256/);
  assert.throws(() => bundle.readBundle(tar.pack([...members, { path: "skills/changelog/extra.sh", data: Buffer.from("x") }])), /extra\.sh is not in the manifest/);
  assert.throws(() => bundle.readBundle(tar.pack(members.filter((m) => m.path !== "memory/MEMORY.md"))), /memory\/MEMORY\.md is listed but missing/);
});

t("symlinks and paths out of the bundle are refused", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "s"));
  fs.symlinkSync("/etc/passwd", path.join(dir, "s", "link"));
  spawnSync("tar", ["-czf", path.join(dir, "l.tar.gz"), "-C", path.join(dir, "s"), "."]);
  assert.throws(() => bundle.readBundle(fs.readFileSync(path.join(dir, "l.tar.gz"))), /not a regular file/);
  // A hand-made ../ member (tar.pack would refuse to write one, so patch a header).
  const raw = zlib.gunzipSync(tar.pack([{ path: "aa/evil.md", data: Buffer.from("x") }]));
  raw.write("../evil.md", 0, "utf8");
  let sum = 0;
  raw.fill(" ", 148, 156);
  for (let i = 0; i < 512; i++) sum += raw[i];
  raw.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  assert.throws(() => bundle.readBundle(zlib.gzipSync(raw)), /unsafe path/);
});

t("import never overwrites a different skill or memory file; --overwrite does", () => {
  const { home } = openclawAgent();
  const buf = bundle.exportBundle("openclaw", { home, memory: true }).buffer;
  const target = tmp();
  write(path.join(target, ".hermes", "skills", "changelog", "SKILL.md"), "mine\n");
  write(path.join(target, ".hermes", "memories", "MEMORY.md"), "hermes' own memory\n");
  assert.throws(() => bundle.importBundle(buf, "hermes", { home: target }), /nothing written.*changelog.*MEMORY\.md/s);
  assert.strictEqual(fs.readFileSync(path.join(target, ".hermes", "skills", "changelog", "SKILL.md"), "utf8"), "mine\n");
  assert.ok(!fs.existsSync(path.join(target, ".hermes", "SOUL.md")), "the persona waits for the clash too");
  const r = bundle.importBundle(buf, "hermes", { home: target, overwrite: true });
  assert.deepStrictEqual(r.skills.map((s) => s.action), ["replaced", "created"]);
  assert.match(fs.readFileSync(path.join(target, ".hermes", "skills", "changelog", "SKILL.md"), "utf8"), /one line each/);
  // A second import of the same bundle changes nothing.
  const again = bundle.importBundle(buf, "hermes", { home: target });
  assert.ok(again.skills.every((s) => s.action === "unchanged") && again.memory.every((m) => m.action === "unchanged"));
});

console.log("bundle: every harness");

t("claude-code and codex: skills and memory land in their own dirs, and come back out", () => {
  const { home } = openclawAgent();
  const buf = bundle.exportBundle("openclaw", { home, memory: true }).buffer;
  const target = tmp();
  bundle.importBundle(buf, "claude-code", { home: target, project: "/srv/site" });
  bundle.importBundle(buf, "codex", { home: target });
  assert.ok(fs.existsSync(path.join(target, ".claude", "skills", "release-notes", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(target, ".claude", "projects", "-srv-site", "memory", "2026-10-13.md")));
  assert.ok(fs.existsSync(path.join(target, ".codex", "skills", "changelog", "scripts", "collect.sh")));
  assert.ok(fs.existsSync(path.join(target, ".codex", "memories", "versioning.md")));
  for (const [h, extra] of [["claude-code", { project: "/srv/site" }], ["codex", {}]]) {
    const back = bundle.exportBundle(h, { home: target, memory: true, ...extra });
    assert.deepStrictEqual(back.manifest.files, bundle.readBundle(buf).manifest.files, h);
  }
});

t("hermes skills grouped by category export by their own name", () => {
  const home = tmp();
  write(path.join(home, "q.persona.yaml"), QUILL_YAML);
  assert.strictEqual(run(["install", "--to=hermes", path.join(home, "q.persona.yaml")], { home }).code, 0);
  write(path.join(home, ".hermes", "skills", "writing", "haiku", "SKILL.md"), "---\nname: haiku\n---\n5-7-5.\n");
  const r = bundle.exportBundle("hermes", { home });
  assert.ok("skills/haiku/SKILL.md" in r.manifest.files);
  assert.strictEqual(r.manifest.persona, "q.persona.yaml");
});

t("export with nothing installed says what to do; --persona names the file", () => {
  const home = tmp();
  const r = run(["export", "--from=codex"], { home });
  assert.strictEqual(r.code, 2);
  assert.match(r.out, /no OpenAgent persona is installed in Codex/);
  write(path.join(home, "quill.persona.yaml"), QUILL_YAML);
  const ok = run(["export", "--from=codex", "--persona", path.join(home, "quill.persona.yaml"), "-o", path.join(home, "a.tar.gz")], { home });
  assert.strictEqual(ok.code, 0, ok.out);
});

t("import --to=5dive off a box says where to run it", () => {
  const { home } = openclawAgent();
  const out = path.join(home, "q.tar.gz");
  fs.writeFileSync(out, bundle.exportBundle("openclaw", { home }).buffer);
  const r = spawnSync(process.execPath, [CLI, "import", out, "--to=5dive"], { env: { ...process.env, HOME: home, PATH: "/nonexistent" }, encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /5dive agent import \S+q\.tar\.gz --as=quill/);
});

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) {
  for (const f of fail) console.log(`  - ${f}`);
  process.exit(1);
}
