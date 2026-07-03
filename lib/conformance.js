"use strict";

// OpenAgent conformance — the machine core behind the "OpenAgent-compatible"
// badge. Runs THIS implementation against the portable suite in
// conformance/manifest.json and reports, per level, whether every case landed
// on its expected verdict.
//
// The manifest is language-agnostic on purpose (see conformance/README.md): a
// third-party tool in any language loads the same file, feeds each case's
// `doc` to its own validator, and earns the badge when it matches. This module
// is the reference runner; `test/conformance.js` and the `openagent
// conformance` / `openagent badge --verify` commands all share it so there is
// exactly one source of truth for what "compliant" means.

const fs = require("fs");
const path = require("path");
const { validateDoc } = require("./validate");

const MANIFEST = path.join(__dirname, "..", "conformance", "manifest.json");

// Cases at level "0.1" are the floor every implementation must pass; "0.2"
// cases additionally require the v0.2 surface (provenance, ext). Asking for a
// level runs that level and everything below it.
const LEVELS = ["0.1", "0.2"];

function levelsUpTo(level) {
  const i = LEVELS.indexOf(level);
  return i === -1 ? LEVELS.slice() : LEVELS.slice(0, i + 1);
}

// Run the suite for `level` (and every level below it). Pass a null/undefined
// level to run all levels. Returns a structured result — no console output, so
// callers own the presentation.
//
//   { level, levels: [...], total, passed, failures: [{name, spec, problems}] }
function runConformance(level) {
  const suite = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const wanted = new Set(level ? levelsUpTo(level) : LEVELS);
  const cases = suite.cases.filter((c) => wanted.has(c.spec));

  const results = [];
  const failures = [];
  for (const c of cases) {
    const res = validateDoc(c.doc);
    const got = res.ok ? "valid" : "invalid";
    const problems = [];

    if (got !== c.expect) {
      problems.push(
        `expected ${c.expect}, got ${got}` + (res.ok ? "" : ` (errors: ${res.errors.join("; ")})`)
      );
    }
    for (const needle of c.expect_errors || []) {
      if (!res.errors.some((e) => e.includes(needle))) {
        problems.push(`expected an error containing "${needle}"; got [${res.errors.join(" | ")}]`);
      }
    }
    for (const needle of c.expect_warnings || []) {
      if (!(res.warnings || []).some((w) => w.includes(needle))) {
        problems.push(
          `expected a warning containing "${needle}"; got [${(res.warnings || []).join(" | ")}]`
        );
      }
    }

    const ok = problems.length === 0;
    results.push({ name: c.name, spec: c.spec, ok, problems });
    if (!ok) failures.push({ name: c.name, spec: c.spec, problems });
  }

  return {
    level: level || null,
    levels: [...wanted],
    total: cases.length,
    passed: cases.length - failures.length,
    results,
    failures,
    ok: failures.length === 0,
  };
}

module.exports = { runConformance, LEVELS, levelsUpTo };
