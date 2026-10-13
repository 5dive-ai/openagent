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
//   - Non-TTY (CI, piped, a fresh box over SSH) takes its answers from flags:
//     `--yes` (or any --name with no TTY) asks nothing. Without either it is a
//     usage error that prints the flag form.

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

// The defaults every answer falls back to — shared by the interactive and the
// --yes path so both produce the same file for the same inputs.
const DEFAULTS = {
  role: "Agent",
  faceAnchor: "neutral expression, soft studio light, photoreal portrait",
  voiceRules: ["clear and concise", "warm but direct"],
  voiceSample: "shipped the fix — here's the receipt.",
};

// Flags pre-fill answers. With --yes (or no TTY and a --name) they ARE the
// answers and nothing is asked, so `npx @5dive/openagent init --yes --name X`
// works in a script, a Dockerfile or a fresh box's first SSH session.
function flagDefaults(opts) {
  return {
    name: opts.name || "",
    role: opts.role || "",
    id: opts.id || "",
    orgName: opts.org || "",
    faceAnchor: opts.face || "",
    faceRef: opts.faceRef || "",
    voiceRules: Array.isArray(opts.voice) ? opts.voice.filter(Boolean) : [],
    voiceSample: opts.sample || "",
    behavior: opts.vibe || "",
  };
}

function finish(a, opts, out) {
  a.id = slugify(a.id) || slugify(a.name) || "agent";
  if (!a.faceRef) a.faceRef = `./faces/${a.id}.png`;
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
  // The default face.ref points into faces/ next to the persona; make the dir
  // so the ref names a real place to drop the image (the schema requires a ref).
  if (/^\.\/faces\//.test(a.faceRef)) {
    fs.mkdirSync(path.join(path.dirname(abs), "faces"), { recursive: true });
    out.faceDir = path.join(path.dirname(file), "faces");
  }
  out.file = file;
  return out;
}

function runNonInteractive(pre, opts, out) {
  if (!pre.name) {
    process.stderr.write("init: --name is required with --yes (e.g. openagent init --yes --name Quill --role \"Release Archivist\").\n");
    out.code = 2;
    return out;
  }
  const role = pre.role || DEFAULTS.role;
  return finish(
    {
      name: pre.name,
      role,
      id: pre.id || slugify(pre.name),
      orgName: pre.orgName,
      behavior: pre.behavior || `${role} for ${pre.orgName || "the team"}.`,
      faceAnchor: pre.faceAnchor || DEFAULTS.faceAnchor,
      faceRef: pre.faceRef,
      voiceRules: pre.voiceRules.length ? pre.voiceRules : DEFAULTS.voiceRules,
      voiceSample: pre.voiceSample || DEFAULTS.voiceSample,
      postsAbout: [],
    },
    opts,
    out
  );
}

async function runInit(opts) {
  const out = { code: 0, file: null, persona: null };
  const pre = flagDefaults(opts);

  if (opts.yes || (!process.stdin.isTTY && pre.name)) return runNonInteractive(pre, opts, out);

  if (!process.stdin.isTTY) {
    process.stderr.write(
      "init: no TTY, so nothing can be asked. Pass the answers as flags:\n" +
        "      openagent init --yes --name Quill --role \"Release Archivist\" --vibe \"Keeps the changelog honest.\"\n"
    );
    out.code = 2;
    return out;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    process.stdout.write(
      "\nLet's make your agent. Five questions — defaults in [brackets], enter to accept.\n\n"
    );

    const a = {};
    a.name = await ask(rl, "1/5 Name (e.g. Quill)", pre.name);
    if (!a.name) {
      process.stderr.write("init: a name is required.\n");
      out.code = 2;
      return out;
    }
    a.role = await ask(rl, "2/5 Job — its title (e.g. Release Archivist)", pre.role || DEFAULTS.role);
    a.id = pre.id || slugify(a.name);
    a.orgName = pre.orgName;

    a.faceAnchor = await ask(
      rl,
      "3/5 Face — a short visual description of the likeness",
      pre.faceAnchor || DEFAULTS.faceAnchor
    );
    a.faceRef = pre.faceRef;

    process.stdout.write("\n");
    a.voiceRules = pre.voiceRules.length ? pre.voiceRules : await askList(rl, "4/5 Voice — how it writes");
    if (!a.voiceRules.length) {
      a.voiceRules = DEFAULTS.voiceRules;
      process.stdout.write(`  (using defaults: ${DEFAULTS.voiceRules.join(" / ")})\n`);
    }
    a.voiceSample = pre.voiceSample || DEFAULTS.voiceSample;

    a.behavior = await ask(
      rl,
      "5/5 Vibe — one line on who it is and what it does",
      pre.behavior || `${a.role} for ${a.orgName || "the team"}.`
    );
    a.postsAbout = [];

    return finish(a, opts, out);
  } finally {
    rl.close();
  }
}

module.exports = { runInit, buildPersona, renderYaml, slugify };
