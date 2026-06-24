"use strict";

// OpenAgent conformance runner.
//
// Runs THIS implementation against the portable suite in
// conformance/manifest.json and asserts every case lands on its expected
// verdict. The manifest is language-agnostic on purpose: a third-party tool
// in any language can load the same file, feed each case's `doc` to its own
// validator, and claim "OpenAgent <level> compliant" when it matches.
//
// Run on its own:  node test/conformance.js          (all levels)
//                  node test/conformance.js 0.1       (only the 0.1 subset)
// Exposed as runConformance() so test/run.js can fold it into `npm test`.

const fs = require("fs");
const path = require("path");
const { validateDoc } = require("../lib/validate");

const MANIFEST = path.join(__dirname, "..", "conformance", "manifest.json");

// Cases at level "0.1" are the floor every implementation must pass; "0.2"
// cases additionally require the v0.2 surface (provenance, ext). Asking for a
// level runs that level and everything below it.
const LEVEL_ORDER = ["0.1", "0.2"];
function levelsUpTo(level) {
  const i = LEVEL_ORDER.indexOf(level);
  return i === -1 ? LEVEL_ORDER : LEVEL_ORDER.slice(0, i + 1);
}

function runConformance(level) {
  const suite = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const wanted = level ? new Set(levelsUpTo(level)) : new Set(LEVEL_ORDER);
  const cases = suite.cases.filter((c) => wanted.has(c.spec));

  let failures = 0;
  for (const c of cases) {
    const res = validateDoc(c.doc);
    const got = res.ok ? "valid" : "invalid";
    const problems = [];

    if (got !== c.expect) {
      problems.push(`expected ${c.expect}, got ${got}` + (res.ok ? "" : ` (errors: ${res.errors.join("; ")})`));
    }
    // Required error substrings must all appear (order-independent).
    for (const needle of c.expect_errors || []) {
      if (!res.errors.some((e) => e.includes(needle))) {
        problems.push(`expected an error containing "${needle}"; got [${res.errors.join(" | ")}]`);
      }
    }
    // Required warning substrings must all appear.
    for (const needle of c.expect_warnings || []) {
      if (!(res.warnings || []).some((w) => w.includes(needle))) {
        problems.push(`expected a warning containing "${needle}"; got [${(res.warnings || []).join(" | ")}]`);
      }
    }

    if (problems.length) {
      failures++;
      console.log(`  FAIL [${c.spec}] ${c.name}`);
      for (const p of problems) console.log(`         ${p}`);
    } else {
      console.log(`  ok   [${c.spec}] ${c.name}`);
    }
  }

  console.log(
    `\nconformance: ${cases.length - failures}/${cases.length} cases passed` +
      (level ? ` (level ${level} and below)` : ` (all levels)`)
  );
  return failures;
}

module.exports = { runConformance };

// Run directly: `node test/conformance.js [level]`.
if (require.main === module) {
  const level = process.argv[2] || null;
  process.exit(runConformance(level) ? 1 : 0);
}
