"use strict";

// `openagent init` — interactive Q&A that scaffolds a valid <id>.persona.yaml
// instead of hand-writing the spec. The goal is "lower the authoring barrier":
// answer a handful of plain questions, get a schema-valid file you can render a
// card from immediately. We ask only what the schema REQUIRES plus the few
// optional fields that pay off most (org, posts_about, links), and we write the
// file in a comment-annotated layout so the result also teaches the spec.
//
// Design notes:
//   - Pure stdlib readline; no new dependency.
//   - Every prompt shows a sensible default in [brackets]; empty answer takes it.
//   - id is slugified from name if left blank, so the fast path is just name+role.
//   - We never overwrite an existing file unless --force is passed.
//   - Non-TTY (CI, piped) is a usage error with guidance — init is interactive
//     by nature; CONTRIBUTING/automation should template the YAML directly.

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const YAML = require("yaml");

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Build the persona object from collected answers. Mirrors the schema's
// required set (id, name, role, face, voice, behavior) and only attaches
// optional blocks when the user actually supplied them.
function buildPersona(a) {
  const persona = {
    openagent: "0.2",
    id: a.id,
    name: a.name,
    role: a.role,
  };
  if (a.orgName) {
    persona.org = { name: a.orgName };
    if (a.orgUrl) persona.org.url = a.orgUrl;
  }
  persona.behavior = a.behavior;
  if (a.postsAbout && a.postsAbout.length) persona.posts_about = a.postsAbout;
  persona.face = { ref: a.faceRef, anchor: a.faceAnchor };
  // written voice is the lowest-friction voice the schema accepts (rules+sample);
  // audio TTS can be added later. minProperties:1 on voice is satisfied by this.
  persona.voice = {
    written: {
      rules: a.voiceRules,
      sample: a.voiceSample,
    },
  };
  const links = {};
  if (a.profile) links.profile = a.profile;
  if (a.repo) links.repo = a.repo;
  if (Object.keys(links).length) persona.links = links;
  return persona;
}

// Render the persona to YAML with a friendly header comment so the scaffold
// is self-documenting (next steps + spec pointer).
function renderYaml(persona) {
  const header =
    "# OpenAgent persona — scaffolded by `openagent init`.\n" +
    "# Spec: https://github.com/5dive-ai/openagent/blob/main/SPEC.md\n" +
    "# Next:  openagent validate " + persona.id + ".persona.yaml   (tier + next rung)\n" +
    "#        openagent card     " + persona.id + ".persona.yaml   (mint your holo card)\n" +
    "# Tip:   add a real face.ref image + a voice.audio.base to climb the rarity ladder.\n\n";
  return header + YAML.stringify(persona);
}

function ask(rl, prompt, def) {
  const tail = def ? ` [${def}]` : "";
  return new Promise((resolve) => {
    rl.question(`${prompt}${tail}\n> `, (ans) => {
      const v = (ans || "").trim();
      resolve(v || def || "");
    });
  });
}

// Collect a list one-per-line until a blank line. Used for voice rules and
// posts_about. Returns [] if the user just hits enter.
async function askList(rl, prompt) {
  process.stdout.write(`${prompt} (one per line, blank to finish)\n`);
  const out = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const v = await new Promise((resolve) =>
      rl.question(`  - `, (a) => resolve((a || "").trim()))
    );
    if (!v) break;
    out.push(v);
  }
  return out;
}

// Pre-fill answers from flags so power users / scripted demos can skip prompts
// they already know (still interactive for the rest). Unknown flags are ignored.
function flagDefaults(opts) {
  return {
    name: opts.name || "",
    role: opts.role || "",
    id: opts.id || "",
    orgName: opts.org || "",
  };
}

async function runInit(opts) {
  const out = { code: 0, file: null, persona: null };

  if (!process.stdin.isTTY) {
    process.stderr.write(
      "init: no TTY — `openagent init` is interactive.\n" +
        "      In CI or scripts, write the YAML directly (see examples/marcus.persona.yaml)\n" +
        "      or pass answers via flags: openagent init --name … --role … --id …\n"
    );
    out.code = 2;
    return out;
  }

  const pre = flagDefaults(opts);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    process.stdout.write(
      "\nLet's scaffold your OpenAgent persona. A few questions — defaults in [brackets], enter to accept.\n\n"
    );

    const a = {};
    a.name = await ask(rl, "Display name (e.g. Marcus)", pre.name);
    if (!a.name) {
      process.stderr.write("init: a name is required.\n");
      out.code = 2;
      return out;
    }
    a.role = await ask(rl, "Role / title (e.g. CTO / Founding Engineer)", pre.role || "Agent");
    a.id = slugify(await ask(rl, "Short id (lowercase, a-z0-9-)", pre.id || slugify(a.name)));
    if (!a.id) a.id = slugify(a.name) || "agent";

    a.orgName = await ask(rl, "Org / team affiliation (optional, enter to skip)", pre.orgName);
    if (a.orgName) a.orgUrl = await ask(rl, "  Org URL (optional)", "");

    a.behavior = await ask(
      rl,
      "Behavior — one line on what this agent does / answers to",
      `${a.role} for ${a.orgName || "the team"}.`
    );

    a.faceAnchor = await ask(
      rl,
      "Face anchor — a short visual description of the likeness",
      "neutral expression, soft studio light, photoreal portrait"
    );
    a.faceRef = await ask(
      rl,
      "Face image ref (path or URL; placeholder ok for now)",
      `./faces/${a.id}.png`
    );

    process.stdout.write("\nVoice — how this agent writes.\n");
    a.voiceRules = await askList(rl, "Writing-style rules");
    if (!a.voiceRules.length) {
      a.voiceRules = ["clear and concise", "warm but direct"];
      process.stdout.write("  (using defaults: clear and concise / warm but direct)\n");
    }
    a.voiceSample = await ask(
      rl,
      "A one-line sample in that voice",
      "shipped the fix — here's the receipt."
    );

    a.postsAbout = await askList(rl, "\nposts_about — topics this agent talks about (optional)");

    process.stdout.write("\nLinks (optional, enter to skip).\n");
    a.profile = await ask(rl, "  Public profile URL", "");
    a.repo = await ask(rl, "  Source repo URL", "");

    a.id = slugify(a.id);
    const persona = buildPersona(a);
    out.persona = persona;

    const file = opts.out || `${a.id}.persona.yaml`;
    const abs = path.resolve(file);
    if (fs.existsSync(abs) && !opts.force) {
      process.stderr.write(
        `\ninit: ${file} already exists — pass -o <file> to choose another name or --force to overwrite.\n`
      );
      out.code = 2;
      return out;
    }
    fs.writeFileSync(abs, renderYaml(persona));
    out.file = file;
    return out;
  } finally {
    rl.close();
  }
}

module.exports = { runInit, buildPersona, renderYaml, slugify };
