"use strict";

// Tiny dependency-free test runner.
const path = require("path");
const { validateFile } = require("../lib/validate");
const { buildSvg, resolveFace } = require("../lib/card");
const { computeTier } = require("../lib/tier");
const YAML = require("yaml");
const fs = require("fs");

let failures = 0;
function check(name, cond) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`);
  }
}

const examples = path.join(__dirname, "..", "examples");
const fixtures = path.join(__dirname, "fixtures");
const load = (f) => YAML.parse(fs.readFileSync(f, "utf8"));

(async () => {
  // 1. Shipped examples validate.
  for (const f of ["marcus.persona.yaml", "lilbro.persona.yaml"]) {
    const r = validateFile(path.join(examples, f));
    check(`${f} validates`, r.ok === true);
    if (!r.ok) console.log("    errors:", r.errors);
  }

  // 2. Broken fixture fails with the expected error classes.
  const bad = validateFile(path.join(fixtures, "broken.persona.yaml"));
  check("broken.persona.yaml fails", bad.ok === false);
  const joined = bad.errors.join("\n");
  check("flags bad id pattern", /\.id:.*pattern/.test(joined));
  check("flags unknown face field 'color'", /unknown field 'color'/.test(joined));
  check("flags missing audio.base", /audio: missing required field 'base'/.test(joined));
  check("flags empty rules array", /rules: must have at least 1 item/.test(joined));

  // 3. Missing file → clean error.
  const missing = validateFile(path.join(fixtures, "does-not-exist.yaml"));
  check("missing file handled", missing.ok === false && /cannot read file/.test(missing.errors[0]));

  // 4. Card SVG embeds the real face + is deterministic per-persona.
  const marcusDoc = load(path.join(examples, "marcus.persona.yaml"));
  const lilDoc = load(path.join(examples, "lilbro.persona.yaml"));
  const mFace = await resolveFace(marcusDoc.face.ref, examples);
  check("face.ref resolves locally", mFace.resolved === true);
  const svg1 = buildSvg(marcusDoc, mFace.dataUri, "rare");
  const svg1b = buildSvg(marcusDoc, mFace.dataUri, "rare");
  check("card svg is valid-ish svg", /^<svg[\s\S]*<\/svg>$/.test(svg1.trim()));
  check("card embeds face image", /data:image\/png;base64,/.test(svg1));
  check("card render is deterministic", svg1 === svg1b);
  check("different personas differ", svg1 !== buildSvg(lilDoc, null, "legendary"));
  check("mythical adds holo wash", /holoWash/.test(buildSvg(lilDoc, null, "mythical")));
  check("common has no glow stack", !/stroke-opacity="0.16"/.test(buildSvg(marcusDoc, null, "common")));

  // 5. Rarity ladder.
  const marcusTier = computeTier(marcusDoc, { faceResolved: true, inRegistry: false });
  check("marcus = Rare (base unset blocks Epic)", marcusTier.tier === "Rare" && marcusTier.level === 2);

  const lilTier = computeTier(lilDoc, { faceResolved: true, inRegistry: false });
  check("lilbro = Legendary (fully specified)", lilTier.tier === "Legendary" && lilTier.level === 4);

  const lilMyth = computeTier(lilDoc, { faceResolved: true, inRegistry: true });
  check("lilbro + registry = Mythical", lilMyth.tier === "Mythical" && lilMyth.level === 5);

  const marcusNoFace = computeTier(marcusDoc, { faceResolved: false, inRegistry: false });
  check("unresolved face drops to Common", marcusNoFace.tier === "Common" && marcusNoFace.level === 1);

  check("completeness is a percentage", marcusTier.completeness > 0 && marcusTier.completeness <= 100);
  check("more-complete persona scores higher", lilTier.completeness > marcusTier.completeness);

  // Missing audio.base entirely → fails Common gate → Ungraded.
  const noBase = JSON.parse(JSON.stringify(marcusDoc));
  delete noBase.voice.audio;
  const ungraded = computeTier(noBase, { faceResolved: true });
  check("missing audio.base = Ungraded", ungraded.level === 0);

  // Common rung is schema validity: an authoritative invalid verdict caps a
  // structurally-complete persona at Ungraded, regardless of other gates.
  const schemaBad = computeTier(lilDoc, { faceResolved: true, inRegistry: true, schemaValid: false });
  check("schemaValid:false = Ungraded (no rungs climb)", schemaBad.level === 0 && schemaBad.gates.common === false);
  const schemaGood = computeTier(marcusDoc, { faceResolved: true, schemaValid: true });
  check("schemaValid:true earns Common", schemaGood.gates.common === true && schemaGood.level >= 1);

  if (failures) {
    console.log(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log("\nall tests passed");
})();
