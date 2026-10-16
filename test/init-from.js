"use strict";

// `openagent init --from=<harness>` (DIVE-6350): an agent that already has a name and
// a persona in its harness keeps them. Every arm runs against a temp $HOME.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const YAML = require("yaml");
const { readText, readHarnessPersona } = require("../lib/harness-persona");
const { renderPart, prependBlock } = require("../lib/install");

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

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "oa-init-from-"));
function put(home, rel, text) {
  const f = path.join(home, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
}
const ENV = { ...process.env };
for (const k of ["HERMES_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete ENV[k];
function cli(home, cwd, ...args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...ENV, HOME: home }, encoding: "utf8", input: "" });
}

// The shapes each harness leaves: OpenClaw's own IDENTITY.md template, filled and unfilled.
const OPENCLAW_TEMPLATE = `# IDENTITY.md - Who Am I?

_Fill this in during your first conversation. Make it yours._

- **Name:**
  _(pick something you like)_
- **Creature:**
  _(AI? robot? familiar? ghost in the machine? something weirder?)_
- **Vibe:**
  _(how do you come across? sharp? warm? chaotic? calm?)_
- **Emoji:**
- **Avatar:**
`;
const OPENCLAW_FILLED = OPENCLAW_TEMPLATE
  .replace("- **Name:**\n  _(pick something you like)_", "- **Name:** Juniper")
  .replace("- **Vibe:**\n  _(how do you come across? sharp? warm? chaotic? calm?)_", "- **Vibe:** Calm, dry, a little nosy.")
  .replace("- **Avatar:**", "- **Avatar:** https://example.com/juniper.png");
const HERMES_DEFAULT = "You are Hermes Agent, an intelligent AI assistant created by Nous Research.\n";
const HERMES_OWN = "You are Hermes Agent.\n\nYour name is Bramble. You are Bramble, the household's research librarian.\nTone: Warm, precise, never in a hurry.\n";
const CLAUDE_OWN = "# Working here\n\nYou are an agent working on the billing service.\n\nYou are **Quill**, a backend engineer. Short answers.\n";
const CLAUDE_PLAIN = "# Project rules\n\n- Run the tests before you push.\n- name: billing-api\n- Title: Q3 cleanup notes from the planning meeting, kept here for later\n";
const CLAUDE_RULES = "# Rules\n\nYou are NEVER to commit secrets.\nYou are ONLY allowed to edit src/.\nYou are ALWAYS to run the tests.\nI am Done when CI is green.\n";

console.log("\n-- reading a harness's own persona --");

t("OpenClaw IDENTITY.md template, unfilled: proposes nothing", () => {
  assert.deepStrictEqual(readText(OPENCLAW_TEMPLATE), {});
});

t("OpenClaw IDENTITY.md, filled: name, vibe and an https avatar", () => {
  assert.deepStrictEqual(readText(OPENCLAW_FILLED), { name: "Juniper", vibe: "Calm, dry, a little nosy", faceRef: "https://example.com/juniper.png" });
});

t("Hermes's stock persona is not the agent's name", () => {
  assert.deepStrictEqual(readText(HERMES_DEFAULT), {});
});

t("Hermes SOUL.md the owner wrote: name past the stock line, its job, its tone", () => {
  assert.deepStrictEqual(readText(HERMES_OWN), { name: "Bramble", role: "household's research librarian", voice: "Warm, precise, never in a hurry" });
});

t("Claude Code CLAUDE.md: 'You are **Quill**, a backend engineer', not 'You are an agent'", () => {
  assert.deepStrictEqual(readText(CLAUDE_OWN), { name: "Quill", role: "backend engineer" });
});

t("a CLAUDE.md of plain rules proposes nothing (a lowercase 'name:' slug is not a name)", () => {
  // A lowercase "name:" is a slug, and a 60+ character "Title:" is not a job.
  assert.deepStrictEqual(readText(CLAUDE_PLAIN), {});
});

t("a rule word is not a name: all-caps NEVER / ONLY / ALWAYS, and a modal like 'Done'", () => {
  assert.deepStrictEqual(readText("You are NEVER to commit secrets."), {});
  assert.deepStrictEqual(readText("I am Done when CI is green."), {});
  assert.deepStrictEqual(readText("You are ONLY allowed to edit src/."), {});
  assert.deepStrictEqual(readText("You are Only allowed to edit src/."), {});
  assert.deepStrictEqual(readText("- **Name:** NEVER"), {});
  assert.deepStrictEqual(readText(CLAUDE_RULES), {});
});

t("a name in any script is kept: Élodie, Алиса, 小明 on a Name: line; Алиса in a sentence", () => {
  assert.deepStrictEqual(readText("- **Name:** Élodie\n- **Role:** Translator\n"), { name: "Élodie", role: "Translator" });
  assert.deepStrictEqual(readText("Name: Алиса"), { name: "Алиса" });
  assert.deepStrictEqual(readText("Name: 小明"), { name: "小明" });
  assert.deepStrictEqual(readText("You are Алиса, a translator."), { name: "Алиса", role: "translator" });
  assert.deepStrictEqual(readText("Your name is Élodie."), { name: "Élodie" });
});

t("a block `install` wrote reads back as that persona (name and job)", () => {
  const p = { openagent: "0.2", id: "felix", name: "Felix", role: "Legal Counsel", behavior: "Careful.", face: { ref: "./f.png", anchor: "x" }, voice: { written: { rules: ["Plain words."] } } };
  const text = prependBlock("", p, renderPart(p, "identity", { builtOn: "Claude Code" }));
  const got = readText(text);
  assert.strictEqual(got.name, "Felix");
  assert.strictEqual(got.role, "Legal Counsel");
});

t("readHarnessPersona: OpenClaw reads IDENTITY.md first and names the files it found", () => {
  const home = tmp();
  put(home, ".openclaw/workspace/AGENTS.md", "You are Pebble, the night shift.\n");
  const id = put(home, ".openclaw/workspace/IDENTITY.md", OPENCLAW_FILLED);
  const h = readHarnessPersona("openclaw", { home });
  assert.strictEqual(h.name, "Juniper");
  assert.strictEqual(h.role, "night shift"); // IDENTITY.md has no job; AGENTS.md fills it
  assert.strictEqual(h.found[0], id);
  assert.strictEqual(h.found.length, 2);
});

t("readHarnessPersona refuses a harness it cannot read (5dive has no persona file)", () => {
  assert.throws(() => readHarnessPersona("5dive"), /--from must be one of hermes, openclaw, claude-code, codex/);
});

console.log("\n-- openagent init --from --");

t("init --yes --from=claude-code keeps the CLAUDE.md name and job, flags fill the rest", () => {
  const home = tmp();
  const cwd = tmp();
  put(home, ".claude/CLAUDE.md", CLAUDE_OWN);
  const r = cli(home, cwd, "init", "--yes", "--from=claude-code", "--vibe", "Ships small.", "--no-publish");
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /from Claude Code \(.*CLAUDE\.md\):.*name .*Quill.* job .*backend engineer/);
  const p = YAML.parse(fs.readFileSync(path.join(cwd, "quill.persona.yaml"), "utf8"));
  assert.strictEqual(p.name, "Quill");
  assert.strictEqual(p.role, "backend engineer");
  assert.strictEqual(p.behavior, "Ships small.");
});

t("a flag still wins over the harness (--role replaces the CLAUDE.md job)", () => {
  const home = tmp();
  const cwd = tmp();
  put(home, ".claude/CLAUDE.md", CLAUDE_OWN);
  const r = cli(home, cwd, "init", "--yes", "--from", "claude-code", "--role", "Staff engineer", "--no-publish");
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  const p = YAML.parse(fs.readFileSync(path.join(cwd, "quill.persona.yaml"), "utf8"));
  assert.strictEqual(p.name, "Quill");
  assert.strictEqual(p.role, "Staff engineer");
});

t("init --from=hermes takes the SOUL.md tone as a voice rule; openclaw's https avatar becomes face.ref", () => {
  const home = tmp();
  const cwd = tmp();
  put(home, ".hermes/SOUL.md", HERMES_OWN);
  put(home, ".openclaw/workspace/IDENTITY.md", OPENCLAW_FILLED);
  let r = cli(home, cwd, "init", "--yes", "--from=hermes", "--no-publish");
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  let p = YAML.parse(fs.readFileSync(path.join(cwd, "bramble.persona.yaml"), "utf8"));
  assert.deepStrictEqual(p.voice.written.rules, ["Warm, precise, never in a hurry"]);
  r = cli(home, cwd, "init", "--yes", "--from=openclaw", "--no-publish");
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  p = YAML.parse(fs.readFileSync(path.join(cwd, "juniper.persona.yaml"), "utf8"));
  assert.strictEqual(p.face.ref, "https://example.com/juniper.png");
  assert.strictEqual(p.behavior, "Calm, dry, a little nosy");
});

t("a harness file with no name: --yes still needs --name, and says it looked", () => {
  const home = tmp();
  const cwd = tmp();
  put(home, ".claude/CLAUDE.md", CLAUDE_PLAIN);
  const r = cli(home, cwd, "init", "--yes", "--from=claude-code", "--no-publish");
  assert.strictEqual(r.status, 2);
  assert.match(r.stdout, /no name or persona stated in .*CLAUDE\.md, so every pick is yours/);
  assert.match(r.stderr, /no name found in Claude Code's persona file, so --name is needed/);
});

t("a CLAUDE.md of all-caps rules: --yes exits 2 asking for --name, writes no never.persona.yaml", () => {
  const home = tmp();
  const cwd = tmp();
  put(home, ".claude/CLAUDE.md", CLAUDE_RULES);
  const r = cli(home, cwd, "init", "--yes", "--from=claude-code", "--no-publish");
  assert.strictEqual(r.status, 2, r.stderr + r.stdout);
  assert.match(r.stderr, /no name found in Claude Code's persona file, so --name is needed/);
  assert.deepStrictEqual(fs.readdirSync(cwd).filter((f) => f.endsWith(".persona.yaml")), []);
});

t("no harness file at all: says so, and --name works as before", () => {
  const home = tmp();
  const cwd = tmp();
  const r = cli(home, cwd, "init", "--yes", "--from=codex", "--name", "Moss", "--no-publish");
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /from Codex: no persona file yet/);
  assert.ok(fs.existsSync(path.join(cwd, "moss.persona.yaml")));
});

t("init --from=<unknown> is a usage error", () => {
  const r = cli(tmp(), tmp(), "init", "--yes", "--from=5dive", "--name", "X", "--no-publish");
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /--from must be one of/);
});

t("init --help names --from", () => {
  const r = cli(tmp(), tmp(), "--help");
  assert.match(r.stdout, /--from hermes\|openclaw\|claude-code\|codex/);
});

console.log(`\n${pass} pass, ${fail.length} fail`);
if (fail.length) {
  for (const f of fail) console.log(`  - ${f}`);
  process.exit(1);
}
