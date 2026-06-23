"use strict";

// Tiny dependency-free test runner for the validator.
const path = require("path");
const assert = require("assert");
const { validateFile } = require("../lib/validate");

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`);
  }
}

const examples = path.join(__dirname, "..", "examples");
const fixtures = path.join(__dirname, "fixtures");

// 1. The shipped examples must validate.
for (const f of ["marcus.persona.yaml", "lilbro.persona.yaml"]) {
  const r = validateFile(path.join(examples, f));
  check(`${f} validates`, r.ok === true);
  if (!r.ok) console.log("    errors:", r.errors);
}

// 2. The broken fixture must fail with the expected error classes.
const bad = validateFile(path.join(fixtures, "broken.persona.yaml"));
check("broken.persona.yaml fails", bad.ok === false);
const joined = bad.errors.join("\n");
check("flags bad id pattern", /\.id:.*pattern/.test(joined));
check("flags unknown face field 'color'", /unknown field 'color'/.test(joined));
check("flags missing audio.base", /audio: missing required field 'base'/.test(joined));
check("flags empty rules array", /rules: must have at least 1 item/.test(joined));

// 3. Missing file → clean error, not a crash.
const missing = validateFile(path.join(fixtures, "does-not-exist.yaml"));
check("missing file handled", missing.ok === false && /cannot read file/.test(missing.errors[0]));

if (failures) {
  console.log(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nall tests passed");
