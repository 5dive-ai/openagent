"use strict";

// OpenAgent conformance test reporter.
//
// The actual matching logic lives in lib/conformance.js (shared with the
// `openagent conformance` / `openagent badge --verify` commands so there is one
// source of truth). This file is the console reporter that folds it into
// `npm test`.
//
// Run on its own:  node test/conformance.js          (all levels)
//                  node test/conformance.js 0.1       (only the 0.1 subset)

const { runConformance } = require("../lib/conformance");

// Returns the number of failing cases (0 = pass), matching the old contract so
// test/run.js keeps working unchanged.
function reportConformance(level) {
  const r = runConformance(level || null);
  for (const c of r.results) {
    if (c.ok) {
      console.log(`  ok   [${c.spec}] ${c.name}`);
    } else {
      console.log(`  FAIL [${c.spec}] ${c.name}`);
      for (const p of c.problems) console.log(`         ${p}`);
    }
  }
  console.log(
    `\nconformance: ${r.passed}/${r.total} cases passed` +
      (level ? ` (level ${level} and below)` : ` (all levels)`)
  );
  return r.failures.length;
}

// Back-compat alias: test/run.js historically imported runConformance from here.
module.exports = { runConformance: reportConformance, reportConformance };

// Run directly: `node test/conformance.js [level]`.
if (require.main === module) {
  const level = process.argv[2] || null;
  process.exit(reportConformance(level) ? 1 : 0);
}
