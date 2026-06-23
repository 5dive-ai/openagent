#!/usr/bin/env node
"use strict";

const path = require("path");
const { validateFile } = require("../lib/validate");

const pkg = require("../package.json");

// Color only when stdout is a TTY.
const useColor = process.stdout.isTTY;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => c("32", s);
const red = (s) => c("31", s);
const dim = (s) => c("2", s);
const bold = (s) => c("1", s);

const USAGE = `${bold("openagent")} — OpenAgent persona spec tooling (v0.1)

${bold("Usage")}
  openagent validate <persona-file> [<persona-file> ...]
  openagent --help
  openagent --version

${bold("validate")}
  Checks a *.persona.yaml (or .json) file against the OpenAgent v0.1
  JSON Schema. Prints a clear pass/fail with readable errors.
  Exit code 0 = all valid, 1 = one or more invalid, 2 = usage/IO error.

${bold("Example")}
  openagent validate marcus.persona.yaml
`;

function main(argv) {
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
  if (cmd !== "validate") {
    process.stderr.write(red(`unknown command: ${cmd}\n\n`));
    process.stderr.write(USAGE);
    return 2;
  }

  const files = args.slice(1);
  if (files.length === 0) {
    process.stderr.write(red("validate: no persona file given\n\n"));
    process.stderr.write(USAGE);
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
      if (res.errors.length === 1 && /^cannot read file:/.test(res.errors[0])) {
        anyIoError = true;
      }
      process.stdout.write(`${red("✗ FAIL")}  ${rel}\n`);
      for (const err of res.errors) {
        process.stdout.write(`        ${red("•")} ${err}\n`);
      }
    }
  }

  if (files.length > 1) {
    process.stdout.write(
      dim(`\n${files.length - invalidCount}/${files.length} valid\n`)
    );
  }

  if (invalidCount > 0) return anyIoError && files.length === 1 ? 2 : 1;
  return 0;
}

process.exit(main(process.argv));
