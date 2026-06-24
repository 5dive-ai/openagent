"use strict";

// Tiny dependency-free test runner.
const path = require("path");
const { validateFile, validate } = require("../lib/validate");
const { buildSvg, resolveFace } = require("../lib/card");
const { computeTier } = require("../lib/tier");
const registry = require("../lib/registry");
const provenance = require("../lib/provenance");
const crypto = require("crypto");
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
  for (const f of ["marcus.persona.yaml", "lilbro.persona.yaml", "marcus-ops.persona.yaml"]) {
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

  // Doc-level validate(doc) mirrors validateFile and feeds computeTier directly.
  check("validate(doc) passes a good persona", validate(marcusDoc).ok === true);
  const docBad = JSON.parse(JSON.stringify(marcusDoc));
  delete docBad.behavior; // schema-required
  check("validate(doc) flags a schema-invalid persona", validate(docBad).ok === false);
  const flowed = computeTier(docBad, { faceResolved: true, schemaValid: validate(docBad).ok });
  check("validate(doc) verdict flows to Ungraded", flowed.level === 0);

  // face.recipe — optional regenerable likeness, additive + back-compat (DIVE-649).
  const withRecipe = JSON.parse(JSON.stringify(marcusDoc));
  withRecipe.face.recipe = { model: "imagen-4", prompt: "p", seed: 481516 };
  check("face.recipe (full) validates", validate(withRecipe).ok === true);
  const strSeed = JSON.parse(JSON.stringify(withRecipe));
  strSeed.face.recipe.seed = "hex-abc";
  check("face.recipe accepts string seed", validate(strSeed).ok === true);
  const noSeed = JSON.parse(JSON.stringify(withRecipe));
  delete noSeed.face.recipe.seed;
  check("face.recipe seed is optional", validate(noSeed).ok === true);
  const noPrompt = JSON.parse(JSON.stringify(withRecipe));
  delete noPrompt.face.recipe.prompt;
  check("face.recipe requires prompt", validate(noPrompt).ok === false);
  const noRecipe = JSON.parse(JSON.stringify(marcusDoc));
  delete noRecipe.face.recipe;
  check("face without recipe still validates (0.1 back-compat)", validate(noRecipe).ok === true);

  // 6. Signed registry — ship + verify.
  const bundled = registry.loadBundled();
  check("bundled manifest verifies against shipped key", bundled.verified === true);
  check("founding cast is the signed snapshot", ["olivia", "marcus", "theo", "dario", "dude", "lilbro"].every((s) => bundled.slugs.has(s)));

  // Offline → membership comes from the verified snapshot, never the network.
  registry._reset();
  const offlineIds = await registry.fetchRegistryIds({ offline: true });
  check("offline ids = founding cast (no network)", offlineIds.has("marcus") && offlineIds.size === bundled.slugs.size);

  // Signature actually gates trust: a slug not in the signed set is not eligible.
  check("non-listed slug is NOT eligible", !offlineIds.has("totally-made-up-pack"));

  // Tamper detection: flipping a byte of the signed payload fails verification.
  const goodBytes = Buffer.from(JSON.stringify(bundled.manifest, null, 2), "utf8");
  const realSig = fs.readFileSync(path.join(__dirname, "..", "registry", "manifest.sig"), "utf8");
  check("good bytes + real sig verify", registry.verifyBytes(goodBytes, realSig) === true);
  const tampered = Buffer.from(goodBytes.toString("utf8").replace("marcus", "hacker"), "utf8");
  check("tampered manifest fails verification", registry.verifyBytes(tampered, realSig) === false);
  check("a forged signature fails verification", registry.verifyBytes(goodBytes, crypto.randomBytes(64).toString("base64")) === false);

  // slugsOf reads both the slim bundled shape and the full character-packs index.
  check("slugsOf reads packs[].slug shape", registry.slugsOf({ packs: [{ slug: "a" }, { slug: "b" }] }).join() === "a,b");
  check("slugsOf reads slugs[] shape", registry.slugsOf({ slugs: ["x", "y"] }).join() === "x,y");

  // 7. Per-file provenance — created_by + signature + remix lineage (DIVE-651).
  // Back-compat: v0.1 files (no provenance) still validate, and verify cleanly
  // reports them as unsigned.
  check("v0.1 persona (no provenance) still validates", validate(marcusDoc).ok === true);
  const unsignedVerdict = provenance.verifyPersona(marcusDoc);
  check("unsigned persona → signed:false, ok:false", unsignedVerdict.signed === false && unsignedVerdict.ok === false);

  // Schema accepts provenance and its sub-shapes.
  const provOnlyLineage = JSON.parse(JSON.stringify(marcusDoc));
  provOnlyLineage.provenance = { derived_from: [{ id: "lilbro", relation: "remix" }] };
  check("provenance with only derived_from validates", validate(provOnlyLineage).ok === true);
  const badRelation = JSON.parse(JSON.stringify(provOnlyLineage));
  badRelation.provenance.derived_from[0].relation = "stolen-from";
  check("derived_from.relation enum is enforced", validate(badRelation).ok === false);
  const createdByNoKey = JSON.parse(JSON.stringify(marcusDoc));
  createdByNoKey.provenance = { created_by: { name: "anon" } };
  check("created_by without key is rejected", validate(createdByNoKey).ok === false);
  const badProvField = JSON.parse(JSON.stringify(marcusDoc));
  badProvField.provenance = { author: "nope" };
  check("unknown provenance field is rejected", validate(badProvField).ok === false);

  // Sign → verify round-trip with a freshly generated identity.
  const kp = provenance.generateKeypair();
  check("keygen yields a PEM keypair", /BEGIN PUBLIC KEY/.test(kp.publicKey) && /BEGIN PRIVATE KEY/.test(kp.privateKey));
  const signed = provenance.signPersona(marcusDoc, { privateKey: kp.privateKey, name: "tester", signedAt: "2026-06-24T00:00:00Z" });
  check("signPersona is pure (input untouched)", marcusDoc.provenance === undefined);
  check("signed persona embeds the public key", signed.provenance.created_by.key === kp.publicKey);
  check("signed persona still validates against the schema", validate(signed).ok === true);
  const rt = provenance.verifyPersona(signed);
  check("round-trip signature verifies", rt.signed === true && rt.ok === true);

  // Integrity: any content change after signing breaks verification.
  const tamperedDoc = JSON.parse(JSON.stringify(signed));
  tamperedDoc.behavior = tamperedDoc.behavior + " (tampered)";
  check("tampering content fails verification", provenance.verifyPersona(tamperedDoc).ok === false);
  const wrongKey = JSON.parse(JSON.stringify(signed));
  wrongKey.provenance.created_by.key = provenance.generateKeypair().publicKey;
  check("swapping the key fails verification", provenance.verifyPersona(wrongKey).ok === false);

  // Canonicalisation: a YAML round-trip / key reorder must NOT break the sig.
  const reordered = YAML.parse(YAML.stringify(signed));
  check("YAML round-trip preserves the signature", provenance.verifyPersona(reordered).ok === true);
  const sigless = JSON.parse(JSON.stringify(signed));
  delete sigless.provenance.signature;
  const a = provenance.canonicalBytes(signed).toString();
  const b = provenance.canonicalBytes(sigless).toString();
  check("canonicalBytes ignores the signature field itself", a === b);

  // The committed signed example self-verifies and declares lineage.
  const opsDoc = load(path.join(examples, "marcus-ops.persona.yaml"));
  const opsVerdict = provenance.verifyPersona(opsDoc);
  check("marcus-ops example signature verifies", opsVerdict.signed === true && opsVerdict.ok === true);
  check("marcus-ops declares derived_from marcus", opsDoc.provenance.derived_from[0].id === "marcus");
  // Provenance is independent of the rarity ladder — adding it changes no tier.
  const opsBase = JSON.parse(JSON.stringify(opsDoc));
  delete opsBase.provenance;
  check("provenance does not affect computed tier", computeTier(opsDoc, { faceResolved: true }).tier === computeTier(opsBase, { faceResolved: true }).tier);

  if (failures) {
    console.log(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log("\nall tests passed");
})();
