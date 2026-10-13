"use strict";

// `openagent init --yes` + `openagent install --to=hermes|openclaw|5dive`
// (DIVE-6137). Every arm runs against a temp $HOME, never the real one.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const YAML = require("yaml");
const { slotsFor, renderPart, stripBlocks, installPersona } = require("../lib/install");
const { verifyPersona } = require("../lib/provenance");
const { validateFile } = require("../lib/validate");

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

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "oa-install-"));
const HERMES_DEFAULT = "You are Hermes Agent, an intelligent AI assistant created by Nous Research.\n";
const OPENCLAW_AGENTS = "# AGENTS.md - Your Workspace\n\nThis folder is home. Treat it that way.\n";

// A fresh home seeded the way each runtime leaves it after its own setup.
function seededHome() {
  const home = tmp();
  fs.mkdirSync(path.join(home, ".hermes"), { recursive: true });
  fs.writeFileSync(path.join(home, ".hermes", "SOUL.md"), HERMES_DEFAULT);
  fs.mkdirSync(path.join(home, ".openclaw", "workspace"), { recursive: true });
  fs.writeFileSync(path.join(home, ".openclaw", "workspace", "AGENTS.md"), OPENCLAW_AGENTS);
  return home;
}

const QUILL = {
  openagent: "0.2",
  id: "quill",
  name: "Quill",
  role: "Release Archivist",
  org: { name: "Inkwell Labs", url: "https://inkwell.example" },
  behavior: "Keeps the changelog honest.",
  face: { ref: "https://example.com/quill.png", anchor: "owl-eyed archivist, ink-stained fingers" },
  voice: { written: { rules: ["dry wit", "dates in ISO"], sample: "2026-10-13: shipped." } },
};

function run(args, { home, cwd, env = {} }) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: home, HERMES_HOME: "", OPENAGENT_HOME: "", NO_COLOR: "1", ...env },
    input: "",
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

// ── the slot map is the CLI's, not a new one ─────────────────────────────────
t("slot map matches the 5dive CLI's measured rows (header.sh TYPE_PERSONA_FILE)", () => {
  const home = "/h";
  assert.deepStrictEqual(slotsFor("hermes", { home }).map((s) => s.file), ["/h/.hermes/SOUL.md"]);
  const oc = slotsFor("openclaw", { home }).map((s) => s.file);
  assert.strictEqual(oc[0], "/h/.openclaw/workspace/AGENTS.md");
  assert.ok(oc.includes("/h/.openclaw/workspace/SOUL.md"));
});

t("hermes honours HERMES_HOME; --dir wins over both", () => {
  const prev = process.env.HERMES_HOME;
  process.env.HERMES_HOME = "/srv/hermes";
  try {
    assert.strictEqual(slotsFor("hermes", { home: "/h" })[0].file, "/srv/hermes/SOUL.md");
    assert.strictEqual(slotsFor("hermes", { home: "/h", dir: "/x" })[0].file, "/x/SOUL.md");
  } finally {
    if (prev === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = prev;
  }
  assert.strictEqual(slotsFor("openclaw", { home: "/h", dir: "/h/.openclaw/workspace-ops" })[0].file,
    "/h/.openclaw/workspace-ops/AGENTS.md");
});

// ── prepend, never overwrite ─────────────────────────────────────────────────
t("hermes: persona is PREPENDED and the Nous default survives byte-for-byte below it", () => {
  const home = seededHome();
  const r = installPersona(QUILL, "hermes", { home });
  assert.strictEqual(r.slots[0].action, "prepended");
  const soul = fs.readFileSync(path.join(home, ".hermes", "SOUL.md"), "utf8");
  assert.ok(soul.startsWith("<!-- openagent:begin id=quill"), "block is first");
  assert.ok(soul.endsWith("\n" + HERMES_DEFAULT), "default persona kept intact after the block");
  assert.ok(soul.indexOf("You are **Quill**, Release Archivist.") < soul.indexOf("You are Hermes Agent"));
  assert.match(soul, /you are Quill, not the default assistant/);
  assert.match(soul, /dry wit/);
  assert.match(soul, /Inkwell Labs/);
});

t("openclaw: role+reporting in AGENTS.md, tone in SOUL.md, name card in IDENTITY.md", () => {
  const home = seededHome();
  const r = installPersona(QUILL, "openclaw", { home });
  assert.deepStrictEqual(r.slots.map((s) => s.action), ["prepended", "created", "created"]);
  const ws = path.join(home, ".openclaw", "workspace");
  const agents = fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8");
  assert.ok(agents.endsWith("\n" + OPENCLAW_AGENTS), "openclaw's own AGENTS.md kept");
  assert.match(agents, /You are \*\*Quill\*\*, Release Archivist\./);
  assert.match(agents, /You are part of Inkwell Labs \(https:\/\/inkwell\.example\)/);
  assert.doesNotMatch(agents, /dry wit/, "tone is not in the role slot");
  const soul = fs.readFileSync(path.join(ws, "SOUL.md"), "utf8");
  assert.match(soul, /- dry wit/);
  assert.match(soul, /2026-10-13: shipped\./);
  const id = fs.readFileSync(path.join(ws, "IDENTITY.md"), "utf8");
  assert.match(id, /\*\*Name:\*\* Quill/);
  assert.match(id, /\*\*Avatar:\*\* https:\/\/example\.com\/quill\.png/);
});

t("re-install replaces the block: one identity per runtime, even across personas", () => {
  const home = seededHome();
  installPersona(QUILL, "hermes", { home });
  const r = installPersona({ ...QUILL, id: "ledger", name: "Ledger", role: "Ledger Steward" }, "hermes", { home });
  assert.strictEqual(r.slots[0].action, "replaced");
  const soul = fs.readFileSync(path.join(home, ".hermes", "SOUL.md"), "utf8");
  assert.strictEqual((soul.match(/openagent:begin/g) || []).length, 1);
  assert.doesNotMatch(soul, /Quill/);
  assert.match(soul, /You are \*\*Ledger\*\*, Ledger Steward\./);
  assert.ok(soul.endsWith("\n" + HERMES_DEFAULT));
});

t("--remove restores every slot byte-exact and deletes the files install created", () => {
  const home = seededHome();
  installPersona(QUILL, "hermes", { home });
  installPersona(QUILL, "openclaw", { home });
  installPersona(QUILL, "hermes", { home, remove: true });
  const r = installPersona(QUILL, "openclaw", { home, remove: true });
  assert.deepStrictEqual(r.slots.map((s) => s.action), ["removed", "removed", "removed"]);
  assert.strictEqual(fs.readFileSync(path.join(home, ".hermes", "SOUL.md"), "utf8"), HERMES_DEFAULT);
  const ws = path.join(home, ".openclaw", "workspace");
  assert.strictEqual(fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8"), OPENCLAW_AGENTS);
  assert.deepStrictEqual(fs.readdirSync(ws), ["AGENTS.md"]);
  // and a second remove is a no-op
  assert.strictEqual(installPersona(QUILL, "hermes", { home, remove: true }).slots[0].action, "absent");
});

t("--dry-run writes nothing", () => {
  const home = seededHome();
  const r = installPersona(QUILL, "openclaw", { home, dryRun: true });
  assert.deepStrictEqual(r.slots.map((s) => s.action), ["would-prepended", "would-created", "would-created"]);
  assert.deepStrictEqual(fs.readdirSync(path.join(home, ".openclaw", "workspace")), ["AGENTS.md"]);
});

t("stripBlocks leaves text without a block untouched", () => {
  assert.strictEqual(stripBlocks(HERMES_DEFAULT), HERMES_DEFAULT);
  assert.strictEqual(stripBlocks(""), "");
});

t("renderPart refuses an unknown part", () => {
  assert.throws(() => renderPart(QUILL, "nope"), /unknown slot part/);
});

// ── the CLI, the way a fresh box runs it ─────────────────────────────────────
t("init --yes with no TTY makes a valid, SIGNED persona and mints the key", () => {
  const home = tmp(), cwd = tmp();
  const r = run(["init", "--yes", "--name", "Quill", "--role=Release Archivist", "--vibe", "Keeps the changelog honest.", "--voice", "dry wit"], { home, cwd });
  assert.strictEqual(r.code, 0, r.out);
  const file = path.join(cwd, "quill.persona.yaml");
  assert.ok(validateFile(file).ok, "validates");
  const doc = YAML.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(doc.role, "Release Archivist");
  assert.deepStrictEqual(doc.voice.written.rules, ["dry wit"]);
  assert.ok(verifyPersona(doc).ok, "signature verifies");
  const key = path.join(home, ".openagent", "agent.key");
  assert.strictEqual(fs.statSync(key).mode & 0o777, 0o600);
  assert.match(r.out, /minted/);
});

t("init with no TTY and no --name exits 2 and prints the flag form", () => {
  const r = run(["init"], { home: tmp(), cwd: tmp() });
  assert.strictEqual(r.code, 2);
  assert.match(r.out, /openagent init --yes --name/);
});

t("init --no-sign writes an unsigned persona and no key", () => {
  const home = tmp(), cwd = tmp();
  const r = run(["init", "--yes", "--name", "Ink", "--no-sign"], { home, cwd });
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(!YAML.parse(fs.readFileSync(path.join(cwd, "ink.persona.yaml"), "utf8")).provenance);
  assert.ok(!fs.existsSync(path.join(home, ".openagent", "agent.key")));
});

t("install --to=hermes then --to=openclaw from the init'd cwd (no file argument)", () => {
  const home = seededHome(), cwd = tmp();
  assert.strictEqual(run(["init", "--yes", "--name", "Quill", "--role", "Release Archivist"], { home, cwd }).code, 0);
  const h = run(["install", "--to=hermes"], { home, cwd });
  assert.strictEqual(h.code, 0, h.out);
  assert.match(fs.readFileSync(path.join(home, ".hermes", "SOUL.md"), "utf8"), /You are \*\*Quill\*\*/);
  const o = run(["install", "--to", "openclaw"], { home, cwd });
  assert.strictEqual(o.code, 0, o.out);
  assert.match(fs.readFileSync(path.join(home, ".openclaw", "workspace", "AGENTS.md"), "utf8"), /You are \*\*Quill\*\*/);
});

t("install warns when the runtime has never run in this home, and still writes", () => {
  const home = tmp(), cwd = tmp();
  run(["init", "--yes", "--name", "Quill"], { home, cwd });
  const r = run(["install", "--to=hermes"], { home, cwd });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /is hermes installed/);
  assert.ok(fs.existsSync(path.join(home, ".hermes", "SOUL.md")));
});

t("install refuses: no --to, unknown runtime, invalid persona, two candidate files", () => {
  const home = tmp(), cwd = tmp();
  assert.strictEqual(run(["install"], { home, cwd }).code, 2);
  assert.strictEqual(run(["install", "--to=claude"], { home, cwd }).code, 2);
  assert.match(run(["install", "--to=hermes"], { home, cwd }).out, /no \*\.persona\.yaml here/);
  fs.writeFileSync(path.join(cwd, "bad.persona.yaml"), "id: Bad Id\n");
  assert.strictEqual(run(["install", "--to=hermes", "bad.persona.yaml"], { home, cwd }).code, 1);
  fs.writeFileSync(path.join(cwd, "two.persona.yaml"), "id: two\n");
  assert.match(run(["install", "--to=hermes"], { home, cwd }).out, /2 persona files here/);
  assert.ok(!fs.existsSync(path.join(home, ".hermes")), "nothing written on a refusal");
});

t("--to=5dive off a box: points at 5dive.ai, no query string", () => {
  const home = tmp(), cwd = tmp();
  run(["init", "--yes", "--name", "Quill"], { home, cwd });
  // PATH is an empty dir: node is spawned by absolute path, and a real 5dive
  // on this machine (a 5dive box runs this suite too) must not be found.
  const r = run(["install", "--to=5dive"], { home, cwd, env: { PATH: tmp() } });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /Get a box: https:\/\/5dive\.ai\n/);
  assert.doesNotMatch(r.out, /\?/);
});

t("--to=5dive on a box: prints the hire command, and --yes runs it", () => {
  const home = tmp(), cwd = tmp(), bin = tmp();
  run(["init", "--yes", "--name", "Quill"], { home, cwd });
  const log = path.join(bin, "argv.log");
  fs.writeFileSync(path.join(bin, "5dive"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n`, { mode: 0o755 });
  const env = { PATH: bin };
  const p = run(["install", "--to=5dive"], { home, cwd, env });
  assert.strictEqual(p.code, 0, p.out);
  assert.match(p.out, /5dive agent import --from-persona=\S*quill\.persona\.yaml --as=quill/);
  assert.ok(!fs.existsSync(log), "printing does not run it");
  const y = run(["install", "--to=5dive", "--yes", "--as", "quill2"], { home, cwd, env });
  assert.strictEqual(y.code, 0, y.out);
  assert.deepStrictEqual(fs.readFileSync(log, "utf8").trim().split("\n"),
    ["agent", "import", `--from-persona=${fs.realpathSync(cwd)}/quill.persona.yaml`, "--as=quill2"]);
});

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) {
  for (const f of fail) console.log(`  - ${f}`);
  process.exit(1);
}
