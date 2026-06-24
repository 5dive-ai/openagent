"use strict";

// Tiny dependency-free test runner.
const path = require("path");
const { validateFile, validate } = require("../lib/validate");
const { buildSvg, resolveFace } = require("../lib/card");
const { computeTier, computeBadges, nextRung } = require("../lib/tier");
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

  // 5b. Collectible badges — orthogonal to the rarity ladder (DIVE-654).
  const opsDocB = load(path.join(examples, "marcus-ops.persona.yaml"));
  const marcusBadges = computeBadges(marcusDoc).map((b) => b.key);
  check("marcus earns sprite-sheet badge (has face.sprite)", marcusBadges.includes("sprite-sheet"));
  check("marcus earns face-recipe badge (has face.recipe)", marcusBadges.includes("face-recipe"));
  const opsBadges = computeBadges(opsDocB).map((b) => b.key);
  check("marcus-ops earns signed + remixed badges", opsBadges.includes("signed") && opsBadges.includes("remixed"));

  // A voice with a reference clip earns voice-clone; absent → not.
  const cloned = JSON.parse(JSON.stringify(marcusDoc));
  cloned.voice.audio.ref = "./voices/marcus.wav";
  check("voice.audio.ref earns voice-clone badge", computeBadges(cloned).some((b) => b.key === "voice-clone"));
  const noClone = JSON.parse(JSON.stringify(marcusDoc));
  delete noClone.voice.audio.ref;
  check("no voice.audio.ref → no voice-clone badge", !computeBadges(noClone).some((b) => b.key === "voice-clone"));

  // Orthogonality: a badge-bearing asset that isn't a tier gate changes no tier.
  const fullBody = JSON.parse(JSON.stringify(marcusDoc));
  fullBody.face.full = "./faces/marcus-full.png";
  check("full-body badge earned", computeBadges(fullBody).some((b) => b.key === "full-body"));
  check("adding full-body asset does not change tier",
    computeTier(fullBody, { faceResolved: true }).tier === computeTier(marcusDoc, { faceResolved: true }).tier);

  // signed badge honours an authoritative ctx.signatureValid verdict over presence.
  check("signed badge respects ctx.signatureValid=false",
    !computeBadges(opsDocB, { signatureValid: false }).some((b) => b.key === "signed"));

  // Next-rung hints: the single rung to chase, or null at the top.
  const nrMarcus = nextRung(computeTier(marcusDoc, { faceResolved: true }), true);
  check("next rung above Rare is Epic", nrMarcus && nrMarcus.label === "Epic" && /voice base/.test(nrMarcus.need));
  const nrUnresolved = nextRung(computeTier(marcusDoc, { faceResolved: false }), false);
  check("unresolved-face Rare hint points at face.ref", nrUnresolved.label === "Rare" && /face\.ref/.test(nrUnresolved.need));
  const nrLil = nextRung(computeTier(lilDoc, { faceResolved: true }), true);
  check("next rung above Legendary is Mythical", nrLil && nrLil.label === "Mythical");
  check("Mythical has no next rung", nextRung(lilMyth, true) === null);

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

  // ext — sanctioned extension namespace, additive + back-compat (DIVE-652).
  // The core schema is closed (additionalProperties:false); ext is the only
  // sanctioned place for tool-specific fields, so adopters don't fork the schema.
  const baseNoExt = JSON.parse(JSON.stringify(marcusDoc));
  delete baseNoExt.ext;
  check("persona without ext validates (back-compat)", validate(baseNoExt).ok === true);
  const withExt = JSON.parse(JSON.stringify(baseNoExt));
  withExt.ext = { "acme-studio": { render_preset: "cinematic-4k", fps: 24 }, fivedive: { pinned: true } };
  check("ext with namespaced tool objects validates", validate(withExt).ok === true);
  check("ext accepts arbitrary fields inside a namespace (open)", validate({
    ...baseNoExt, ext: { mytool: { anything: ["a", 1, { nested: true }], flag: false } },
  }).ok === true);
  const flatExt = JSON.parse(JSON.stringify(baseNoExt));
  flatExt.ext = { stray_scalar: "nope" };
  check("ext rejects un-namespaced scalars (value must be an object)", validate(flatExt).ok === false);
  const unknownTop = JSON.parse(JSON.stringify(baseNoExt));
  unknownTop.unsanctioned = { foo: 1 };
  check("a non-ext unknown top-level field is still rejected (core stays closed)", validate(unknownTop).ok === false);
  // ext is part of the document → covered by provenance signing, and inert for rarity.
  const extTier = computeTier(withExt, { faceResolved: true });
  const noExtTier = computeTier(baseNoExt, { faceResolved: true });
  check("ext does not affect computed tier", extTier.tier === noExtTier.tier);
  const extKp = provenance.generateKeypair();
  const extSigned = provenance.signPersona(withExt, { privateKey: extKp.privateKey });
  check("ext is covered by the signature (verifies)", provenance.verifyPersona(extSigned).ok === true);
  const extTampered = JSON.parse(JSON.stringify(extSigned));
  extTampered.ext["acme-studio"].fps = 60;
  check("tampering ext breaks the signature", provenance.verifyPersona(extTampered).ok === false);

  // The shipped marcus example carries a real ext block and still validates.
  check("marcus example ext.fivedive present", marcusDoc.ext && marcusDoc.ext.fivedive.dashboard_pinned === true);

  // links — identity layer points at the capability layer via agent_card (DIVE-653).
  // OpenAgent describes who an agent IS; the linked A2A AgentCard describes what it
  // can DO. The two compose; links stays an open string map for back-compat.
  const baseLinks = JSON.parse(JSON.stringify(marcusDoc));
  check("marcus example carries links.agent_card", typeof baseLinks.links.agent_card === "string");
  const withCard = JSON.parse(JSON.stringify(baseLinks));
  withCard.links = { agent_card: "https://example.com/.well-known/agent.json", profile: "https://x.test" };
  check("links.agent_card (named key) validates", validate(withCard).ok === true);
  const arbLinks = JSON.parse(JSON.stringify(baseLinks));
  arbLinks.links = { whatever_custom: "https://x.test/y" };
  check("links still accepts arbitrary string keys (open, back-compat)", validate(arbLinks).ok === true);
  const nonStrLink = JSON.parse(JSON.stringify(baseLinks));
  nonStrLink.links = { agent_card: 42 };
  check("links values must be strings (non-string rejected)", validate(nonStrLink).ok === false);
  const noLinks = JSON.parse(JSON.stringify(baseLinks));
  delete noLinks.links;
  check("persona without links still validates", validate(noLinks).ok === true);
  // agent_card is a link, not a rarity gate — adding it changes no tier.
  check("links.agent_card does not change computed tier",
    computeTier(withCard, { faceResolved: true }).tier === computeTier(arbLinks, { faceResolved: true }).tier);

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
