#!/usr/bin/env node
"use strict";

const path = require("path");
const { validateFile } = require("../lib/validate");
const { renderCard, resolveFace, fetchRegistryIds } = require("../lib/card");
const { computeTier, TIER_STYLE } = require("../lib/tier");
const YAML = require("yaml");
const fs = require("fs");

const pkg = require("../package.json");

// Color only when stdout is a TTY.
const useColor = process.stdout.isTTY;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => c("32", s);
const red = (s) => c("31", s);
const dim = (s) => c("2", s);
const bold = (s) => c("1", s);

// 256-colour hex -> nearest ansi is overkill; just bold the tier word.
function tierTag(name) {
  return bold(name.toUpperCase());
}

const USAGE = `${bold("openagent")} — OpenAgent persona spec tooling (v0.1)

${bold("Usage")}
  openagent validate <persona-file> [<persona-file> ...]
  openagent card <persona-file> [-o <out.png>]
  openagent tier <persona-file> [--json]
  openagent --help
  openagent --version

${bold("validate")}
  Checks a *.persona.yaml (or .json) file against the OpenAgent v0.1
  JSON Schema. Prints a clear pass/fail with readable errors.
  Exit code 0 = all valid, 1 = one or more invalid, 2 = usage/IO error.

${bold("card")}
  Renders a shareable PNG "trading card" from a persona: avatar (face.ref),
  a voice waveform from voice.audio (base+style), name, role, the written
  sample, and the computed rarity tier. Writes <id>.card.png unless -o given.

${bold("tier")}
  Prints the computed rarity tier + completeness % + the gate breakdown.
  Tiers (gate ladder, highest passing wins): Common < Rare < Epic <
  Legendary < Mythical. Tiers 1-4 are a pure function of the persona file;
  Mythical is conferred by membership in the character-packs registry.

${bold("Examples")}
  openagent validate marcus.persona.yaml
  openagent card marcus.persona.yaml -o marcus.png
  openagent tier marcus.persona.yaml --json
`;

function loadPersona(file) {
  const raw = fs.readFileSync(file, "utf8");
  return YAML.parse(raw);
}

async function cmdCard(args) {
  let out = null;
  let checkRegistry = true;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o" || args[i] === "--out") out = args[++i];
    else if (args[i] === "--no-registry") checkRegistry = false;
    else positional.push(args[i]);
  }
  if (positional.length === 0) {
    process.stderr.write(red("card: no persona file given\n\n") + USAGE);
    return 2;
  }
  const file = positional[0];
  const v = validateFile(file);
  if (!v.ok) {
    process.stdout.write(`${red("✗")} ${file} is not a valid persona — fix it first:\n`);
    for (const err of v.errors) process.stdout.write(`        ${red("•")} ${err}\n`);
    return 1;
  }
  const res = await renderCard(file, out, { checkRegistry });
  if (!res.ok) {
    process.stderr.write(red(`card: ${res.error}\n`));
    return 2;
  }
  const kb = Math.round(res.bytes / 1024);
  const faceNote = res.faceResolved ? "" : dim(" · no face (monogram)");
  process.stdout.write(
    `${green("✓ CARD")}  ${res.outPath} ${dim(`(${res.width}×${res.height}, ${kb}KB)`)} — ${tierTag(res.tier)} ${dim(`· ${res.completeness}% complete`)}${faceNote}\n`
  );
  return 0;
}

async function cmdTier(args) {
  const json = args.includes("--json");
  let checkRegistry = !args.includes("--no-registry");
  const file = args.find((a) => !a.startsWith("-"));
  if (!file) {
    process.stderr.write(red("tier: no persona file given\n\n") + USAGE);
    return 2;
  }
  const v = validateFile(file);
  if (!v.ok) {
    if (json) process.stdout.write(JSON.stringify({ ok: false, errors: v.errors }, null, 2) + "\n");
    else {
      process.stdout.write(`${red("✗")} ${file} is not a valid persona:\n`);
      for (const err of v.errors) process.stdout.write(`        ${red("•")} ${err}\n`);
    }
    return 1;
  }
  let persona;
  try {
    persona = loadPersona(file);
  } catch (e) {
    process.stderr.write(red(`tier: ${e.message}\n`));
    return 2;
  }
  const face = await resolveFace(persona.face?.ref, path.dirname(path.resolve(file)));
  let inRegistry = false;
  if (checkRegistry) inRegistry = (await fetchRegistryIds()).has(persona.id);
  const t = computeTier(persona, { faceResolved: face.resolved, inRegistry });

  if (json) {
    process.stdout.write(
      JSON.stringify(
        { ok: true, id: persona.id, tier: t.tier, level: t.level, completeness: t.completeness, faceResolved: face.resolved, inRegistry, gates: t.gates },
        null, 2
      ) + "\n"
    );
    return 0;
  }

  process.stdout.write(`${tierTag(t.tier)} ${dim(`· ${t.completeness}% complete`)}  ${dim(path.basename(file))}\n`);
  // Ladder semantics: rungs below the achieved level are earned; the first
  // unmet rung is the blocker; everything above it is locked.
  const order = ["common", "rare", "epic", "legendary", "mythical"];
  const labels = ["Common", "Rare", "Epic", "Legendary", "Mythical"];
  const need = {
    common: "id, name, role, voice.audio.base, written.sample",
    rare: face.resolved ? "non-stub written.sample" : "face.ref must resolve to a real image",
    epic: "named voice base (not 'unset') + behavior",
    legendary: "voice.style + face anchor & sprite + links + posts_about",
    mythical: "listed in the character-packs registry",
  };
  for (let i = 0; i < order.length; i++) {
    if (i < t.level) {
      process.stdout.write(`  ${green("✓")} ${labels[i]}\n`);
    } else if (i === t.level) {
      process.stdout.write(`  ${red("✗")} ${labels[i]} ${dim(`— needs ${need[order[i]]}`)}\n`);
    } else {
      process.stdout.write(`  ${dim("🔒 " + labels[i])}\n`);
    }
  }
  return 0;
}

function cmdValidate(files) {
  if (files.length === 0) {
    process.stderr.write(red("validate: no persona file given\n\n") + USAGE);
    return 2;
  }
  let invalidCount = 0;
  let anyIoError = false;
  for (const file of files) {
    const rel = path.relative(process.cwd(), path.resolve(file)) || file;
    const res = validateFile(file);
    if (res.ok) {
      const idNote = res.id ? dim(` (id: ${res.id})`) : "";
      process.stdout.write(`${green("✓ PASS")}  ${rel}${idNote}\n`);
    } else {
      invalidCount++;
      if (res.errors.length === 1 && /^cannot read file:/.test(res.errors[0])) anyIoError = true;
      process.stdout.write(`${red("✗ FAIL")}  ${rel}\n`);
      for (const err of res.errors) process.stdout.write(`        ${red("•")} ${err}\n`);
    }
  }
  if (files.length > 1) {
    process.stdout.write(dim(`\n${files.length - invalidCount}/${files.length} valid\n`));
  }
  if (invalidCount > 0) return anyIoError && files.length === 1 ? 2 : 1;
  return 0;
}

async function main(argv) {
  const args = argv.slice(2);

  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    process.stdout.write(USAGE);
    return args.length === 0 ? 2 : 0;
  }
  if (args[0] === "-v" || args[0] === "--version") {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }

  const cmd = args[0];
  const rest = args.slice(1);

  if (cmd === "validate") return cmdValidate(rest);
  if (cmd === "card") return cmdCard(rest);
  if (cmd === "tier") return cmdTier(rest);

  process.stderr.write(red(`unknown command: ${cmd}\n\n`) + USAGE);
  return 2;
}

main(process.argv).then((code) => process.exit(code)).catch((e) => {
  process.stderr.write(red(`error: ${e.stack || e.message}\n`));
  process.exit(2);
});
