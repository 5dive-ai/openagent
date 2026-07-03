"use strict";

// Tiny dependency-free test runner.
const path = require("path");
const { validateFile, validate, versionWarnings, placeholderWarnings, SPEC_VERSION, KNOWN_VERSIONS } = require("../lib/validate");
const { runConformance } = require("./conformance");
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

  // 4b. Animated card (DIVE-665): motion is opt-in + back-compat, tier-aware,
  // and the APNG encoder stitches resvg frames with no native deps.
  check("static card byte-identical when motion omitted",
    buildSvg(lilDoc, null, "legendary") === buildSvg(lilDoc, null, "legendary", undefined));
  const lgA = buildSvg(lilDoc, null, "legendary", { phase: 0 });
  const lgB = buildSvg(lilDoc, null, "legendary", { phase: 0.5 });
  check("foil tier animates (frames differ across phase)", lgA !== lgB);
  check("common stays still even when animated (no foil/glow)",
    buildSvg(marcusDoc, null, "common", { phase: 0 }) === buildSvg(marcusDoc, null, "common", { phase: 0.5 }));
  check("mythical holo hue flows with phase",
    buildSvg(lilDoc, null, "mythical", { phase: 0 }) !== buildSvg(lilDoc, null, "mythical", { phase: 0.4 }));
  // APNG encoder: stitches equal-dimension PNGs into a looping APNG, with
  // run-length dedup (identical CONSECUTIVE frames collapse into one frame with a
  // proportionally longer delay — the calm-cadence static rest shrinks the file).
  // Use solid-color frames so the structural checks don't depend on the renderer's
  // animation cadence; a separate check exercises the dedup directly.
  const { encodeApng, parseChunks } = require("../lib/apng");
  const { Resvg } = require("@resvg/resvg-js");
  const solid = (hex) => new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="90" height="126"><rect width="90" height="126" fill="${hex}"/></svg>`).render().asPng();
  const fR = solid("#ff0000"), fG = solid("#00cc00"), fB = solid("#0066ff");
  const apng = encodeApng([fR, fG, fB], { delayNum: 1, delayDen: 12 });
  const chunks = parseChunks(apng);
  check("apng has PNG signature", apng.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  check("apng declares acTL run count (3 distinct frames → 3)", (() => {
    const ac = chunks.find((c) => c.type === "acTL");
    return ac && ac.data.readUInt32BE(0) === 3;
  })());
  check("apng emits one fcTL per run + fdAT after the first", (() => {
    const fcTL = chunks.filter((c) => c.type === "fcTL").length;
    const fdAT = chunks.filter((c) => c.type === "fdAT").length;
    return fcTL === 3 && fdAT >= 2;
  })());
  check("apng run-length dedups identical consecutive frames", (() => {
    // [A,A,A,B,B] → 2 runs; the A-run carries a 3× delay, the B-run 2× (so the
    // collapsed frames still display for the right duration). Distinct frames above
    // stayed 1-run each, proving it's a no-op when nothing repeats.
    const dd = parseChunks(encodeApng([fR, fR, fR, fB, fB], { delayNum: 1, delayDen: 10 }));
    const ac = dd.find((c) => c.type === "acTL");
    const fcTLs = dd.filter((c) => c.type === "fcTL");
    return ac && ac.data.readUInt32BE(0) === 2 && fcTLs.length === 2 &&
      fcTLs[0].data.readUInt16BE(20) === 3 && fcTLs[1].data.readUInt16BE(20) === 2;
  })());

  // 5. Rarity — identity-seeded random (v0.2), NOT completeness-earned.
  const KEY = "did:key:z6MkExampleSeedAAAA";
  const r1 = computeTier(marcusDoc, { didKey: KEY, schemaValid: true });
  const r2 = computeTier(marcusDoc, { didKey: KEY, schemaValid: true });
  check("rarity is deterministic per identity (same did:key → same tier)",
    r1.tier === r2.tier && r1.level === r2.level);
  check("a graded roll lands in Common..Legendary, gates.graded=true",
    ["Common", "Rare", "Epic", "Legendary"].includes(r1.tier) && r1.gates.graded === true);

  // The seed is the did:key, NOT the user-chosen id — renaming can't re-roll.
  const renamed = JSON.parse(JSON.stringify(marcusDoc));
  renamed.id = "totally-different-id";
  check("renaming id does not change rarity (seed = did:key, not id)",
    computeTier(renamed, { didKey: KEY, schemaValid: true }).tier === r1.tier);
  // A different identity can roll a different tier.
  check("a different did:key is an independent roll",
    typeof computeTier(marcusDoc, { didKey: "did:key:z6MkOther", schemaValid: true }).tier === "string");

  // Entry rule: must be schema-valid AND have an identity key to be graded.
  check("no identity key → Ungraded (even if schema-valid)",
    computeTier(marcusDoc, { schemaValid: true }).tier === "Ungraded");
  check("Ungraded has gates.graded=false",
    computeTier(marcusDoc, { schemaValid: true }).gates.graded === false);
  check("schemaValid:false → Ungraded (even with an identity key)",
    computeTier(marcusDoc, { didKey: KEY, schemaValid: false }).tier === "Ungraded");

  // Mythical is conferred by the curated registry, never rolled.
  const lilMyth = computeTier(marcusDoc, { didKey: KEY, inRegistry: true, schemaValid: true });
  check("inRegistry → Mythical (conferred)", lilMyth.tier === "Mythical" && lilMyth.level === 5);

  // Real signed persona: its tier derives from its own provenance.created_by.key.
  const opsSigned = load(path.join(examples, "marcus-ops.persona.yaml"));
  check("a signed persona is graded via its own did:key",
    computeTier(opsSigned, { faceResolved: true, schemaValid: true }).tier !== "Ungraded");

  // Distribution: over many identities, ≈ 40/30/20/10 (curve v2; tolerance for sampling).
  (() => {
    const N = 4000;
    const c = { Common: 0, Rare: 0, Epic: 0, Legendary: 0 };
    for (let i = 0; i < N; i++) {
      c[computeTier(marcusDoc, { didKey: "did:key:z6Mk" + i, schemaValid: true }).tier]++;
    }
    const pct = (k) => c[k] / N;
    check("distribution ≈ Common 40%", Math.abs(pct("Common") - 0.4) < 0.04);
    check("distribution ≈ Rare 30%", Math.abs(pct("Rare") - 0.3) < 0.04);
    check("distribution ≈ Epic 20%", Math.abs(pct("Epic") - 0.2) < 0.03);
    check("distribution ≈ Legendary 10%", Math.abs(pct("Legendary") - 0.1) < 0.03);
  })();

  // Founding-cast pins: the 5dive team holds its pre-curve-v2 tier regardless of
  // what the new curve would roll their did:key to. Keyed by immutable did:key.
  (() => {
    const PINS = {
      "did:key:z6MkfxJdF5PhqHcgpKNy9vY6Y9MAzZJ9EqqVywXqFJUa8VaG": "Legendary", // marcus
      "did:key:z6MkmCyZtZkk37mb46ekUGKkW5zLBU94u1ZPS5BTU9FfqQfE": "Legendary", // olivia
      "did:key:z6MkqKc8VDUidM6VXoxeURDAdC6EEH2Mi4SqkB8NRpkXhbJL": "Epic",      // lilbro
      "did:key:z6Mkw1KjXTrwEMRqMYhNJobvboNFMM9AQUt1ZNudxV45vsjK": "Epic",      // theo
      "did:key:z6Mkey1FXu4tk4UMxDEbosfD2Gqx6u7qj3EP2atsEuAkSRwL": "Rare",      // dario
      "did:key:z6Mki47TZEj3KTmVW2naTPU1FzqwxhN74Qq5CttQxYLehHUh": "Common",    // dude
    };
    for (const [did, want] of Object.entries(PINS)) {
      const got = computeTier(marcusDoc, { didKey: did, schemaValid: true }).tier;
      check(`founding pin holds: ${did.slice(0, 16)}… → ${want}`, got === want);
    }
    // A pin must NOT override conferral — an in-registry founding id is still Mythical.
    const pinnedButConferred = computeTier(marcusDoc, {
      didKey: "did:key:z6Mki47TZEj3KTmVW2naTPU1FzqwxhN74Qq5CttQxYLehHUh", // dude (pinned Common)
      schemaValid: true,
      inRegistry: true,
    }).tier;
    check("conferral beats a pin (in-registry → Mythical)", pinnedButConferred === "Mythical");
  })();

  // Friendly ID (handle·fingerprint) — derived from the did:key, verifiable.
  (() => {
    const did = "did:key:z6MkfxJdF5PhqHcgpKNy9vY6Y9MAzZJ9EqqVywXqFJUa8VaG";
    const fp = provenance.fingerprintFromDidKey(did);
    check("fingerprint is 6 lowercase Crockford-base32 chars", /^[0-9a-hjkmnp-tv-z]{6}$/.test(fp));
    check("fingerprint is deterministic per did:key", provenance.fingerprintFromDidKey(did) === fp);
    check("different did:key → different fingerprint",
      provenance.fingerprintFromDidKey("did:key:z6MkOtherKeyAAAA") !== fp);
    const fid = provenance.friendlyId("marcus", did);
    check("friendlyId display = handle·fingerprint", fid.display === `marcus·${fp}`);
    check("friendlyId urlSafe = handle-fingerprint", fid.urlSafe === `marcus-${fp}`);
    check("verify accepts the correct display form", provenance.verifyFriendlyId(`marcus·${fp}`, did, "marcus").ok);
    check("verify accepts the url-safe form", provenance.verifyFriendlyId(`marcus-${fp}`, did, "marcus").ok);
    check("verify accepts a bare fingerprint", provenance.verifyFriendlyId(fp, did).ok);
    check("verify rejects a wrong fingerprint", !provenance.verifyFriendlyId("marcus·zzzzzz", did, "marcus").ok);
    check("verify rejects impersonation (right fp, wrong handle)",
      !provenance.verifyFriendlyId(`notmarcus·${fp}`, did, "marcus").ok);
  })();

  check("completeness is a percentage", r1.completeness > 0 && r1.completeness <= 100);
  check("more-complete persona scores higher",
    computeTier(lilDoc, { didKey: KEY, schemaValid: true }).completeness >
      computeTier(marcusDoc, { didKey: KEY, schemaValid: true }).completeness);

  // Doc-level validate(doc) still gates grading: schema-invalid → Ungraded.
  check("validate(doc) passes a good persona", validate(marcusDoc).ok === true);
  const docBad = JSON.parse(JSON.stringify(marcusDoc));
  delete docBad.behavior; // schema-required
  check("validate(doc) flags a schema-invalid persona", validate(docBad).ok === false);
  const flowed = computeTier(docBad, { didKey: KEY, schemaValid: validate(docBad).ok });
  check("schema-invalid verdict → Ungraded", flowed.level === 0 && flowed.tier === "Ungraded");

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

  // Progression hint: get graded (if Ungraded) or climb to Mythical; null at top.
  const nrUngraded = nextRung(computeTier(marcusDoc, { schemaValid: true }));
  check("Ungraded persona is told to validate + sign",
    nrUngraded && nrUngraded.goal === "graded" && /sign/.test(nrUngraded.need));
  const nrGraded = nextRung(computeTier(marcusDoc, { didKey: KEY, schemaValid: true }));
  check("a graded persona's only climb is Mythical",
    nrGraded && nrGraded.label === "Mythical" && /registry/.test(nrGraded.need));
  check("Mythical has no next goal", nextRung(lilMyth) === null);

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

  // org — optional affiliation for grouping/filtering, additive + inert for rarity.
  check("persona without org validates (back-compat)", validate(baseNoExt).ok === true);
  const withOrg = JSON.parse(JSON.stringify(marcusDoc));
  withOrg.org = { name: "5dive", url: "https://5dive.ai" };
  check("org { name, url } validates", validate(withOrg).ok === true);
  const orgNameOnly = JSON.parse(JSON.stringify(marcusDoc));
  orgNameOnly.org = { name: "5dive" };
  check("org with name only validates (url optional)", validate(orgNameOnly).ok === true);
  const orgNoName = JSON.parse(JSON.stringify(marcusDoc));
  orgNoName.org = { url: "https://x.test" };
  check("org requires name", validate(orgNoName).ok === false);
  const orgScalar = JSON.parse(JSON.stringify(marcusDoc));
  orgScalar.org = "5dive";
  check("org must be an object (bare string rejected)", validate(orgScalar).ok === false);
  check("org does not affect rarity",
    computeTier(withOrg, { didKey: KEY, schemaValid: true }).tier ===
      computeTier(marcusDoc, { didKey: KEY, schemaValid: true }).tier);
  check("lilbro example carries org.name = 5dive", lilDoc.org && lilDoc.org.name === "5dive");

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

  // 5c. Version field — top-level `openagent:` is optional pre-1.0 (warn),
  // REQUIRED from 1.0 (DIVE-655). Warnings never fail validation.
  const noVer = JSON.parse(JSON.stringify(marcusDoc));
  delete noVer.openagent;
  const noVerRes = validate(noVer);
  check("missing version still validates (optional pre-1.0)", noVerRes.ok === true);
  check("missing version emits a warning", noVerRes.warnings.some((w) => /required from spec 1\.0/i.test(w)));
  const verRes = validate({ ...noVer, openagent: SPEC_VERSION });
  check("declared known version → no version warning", verRes.ok === true && verRes.warnings.length === 0);
  const futureRes = validate({ ...noVer, openagent: "9.9" });
  check("unknown version validates but warns", futureRes.ok === true && futureRes.warnings.some((w) => /unrecognised spec version/.test(w)));
  check("KNOWN_VERSIONS includes the current SPEC_VERSION", KNOWN_VERSIONS.includes(SPEC_VERSION));
  check("versionWarnings is a pure helper (empty for a versioned doc)", versionWarnings({ openagent: "0.1", id: "x" }).length === 0);

  // 5d. Placeholder org guard — a left-in template org.name prints on the card
  // footer verbatim, so warn (never fail) so it isn't shipped as someone else's
  // brand. Catches the shipped example value ("5dive"), generic fillers, and the
  // angle-bracket token; case/space/bracket-insensitive.
  const placeholderRe = /leftover template placeholder/i;
  const fiveDive = validate({ ...noVer, openagent: SPEC_VERSION, org: { name: "5dive" } });
  check("placeholder org '5dive' validates but warns", fiveDive.ok === true && fiveDive.warnings.some((w) => placeholderRe.test(w)));
  check("placeholder org match is normalised (< Your Org >)", placeholderWarnings({ org: { name: "<Your Org>" } }).some((w) => placeholderRe.test(w)));
  check("real org name → no placeholder warning", placeholderWarnings({ org: { name: "Yuri Matcha" } }).length === 0);
  check("absent org block → no placeholder warning", placeholderWarnings({ id: "x" }).length === 0);
  check("placeholderWarnings is a pure helper (non-string org.name ignored)", placeholderWarnings({ org: { name: 42 } }).length === 0);

  // 6. Signed registry — ship + verify.
  const bundled = registry.loadBundled();
  check("bundled manifest verifies against shipped key", bundled.verified === true);
  check("Mythical reserved — manifest snapshot is empty", bundled.slugs.size === 0);

  // Offline → membership comes from the verified snapshot, never the network.
  registry._reset();
  const offlineIds = await registry.fetchRegistryIds({ offline: true });
  check("offline ids empty — no Mythical conferred (no network)", offlineIds.size === 0 && offlineIds.size === bundled.slugs.size);

  // Signature actually gates trust: a slug not in the signed set is not eligible.
  check("non-listed slug is NOT eligible", !offlineIds.has("totally-made-up-pack"));

  // Tamper detection: flipping a byte of the signed payload fails verification.
  const goodBytes = Buffer.from(JSON.stringify(bundled.manifest, null, 2), "utf8");
  const realSig = fs.readFileSync(path.join(__dirname, "..", "registry", "manifest.sig"), "utf8");
  check("good bytes + real sig verify", registry.verifyBytes(goodBytes, realSig) === true);
  const tampered = Buffer.from(goodBytes.toString("utf8").replace("Mythical", "Hacked"), "utf8");
  check("tampered manifest fails verification", registry.verifyBytes(tampered, realSig) === false);
  check("a forged signature fails verification", registry.verifyBytes(goodBytes, crypto.randomBytes(64).toString("base64")) === false);

  // slugsOf honors an explicit curated slugs[] only; a marketplace packs[] index
  // confers NOTHING (DIVE-674: marketplace membership != Mythical).
  check("slugsOf does NOT confer Mythical from marketplace packs[] (DIVE-674)", registry.slugsOf({ packs: [{ slug: "a" }, { slug: "b" }] }).length === 0);
  check("slugsOf reads curated slugs[] shape", registry.slugsOf({ slugs: ["x", "y"] }).join() === "x,y");

  // 6b. FEDERATED registries (DIVE-689) — anyone can run their own signed source.
  {
    // A federated operator's own ed25519 key pair.
    const kp = crypto.generateKeyPairSync("ed25519");
    const fedPubPem = kp.publicKey.export({ type: "spki", format: "pem" }).toString();
    const fedIndex = Buffer.from(JSON.stringify({ slugs: ["acme-bot", "acme-helper"] }), "utf8");
    const fedSig = crypto.sign(null, fedIndex, kp.privateKey).toString("base64");
    // A DIFFERENT key — used to forge.
    const evil = crypto.generateKeyPairSync("ed25519");
    const evilSig = crypto.sign(null, fedIndex, evil.privateKey).toString("base64");

    // normalizeSource: drops sources with no usable key / bad url; keeps good ones.
    check("normalizeSource drops keyless source", registry.normalizeSource({ name: "x", url: "https://e/i.json" }) === null);
    check("normalizeSource drops non-http url", registry.normalizeSource({ name: "x", url: "ftp://e/i", publicKey: fedPubPem }) === null);
    const norm = registry.normalizeSource({ name: "acme", url: "https://acme.test/index.json", publicKey: fedPubPem });
    check("normalizeSource accepts inline PEM key", norm && norm.name === "acme" && norm.publicKey.includes("BEGIN PUBLIC KEY"));
    check("normalizeSource defaults sigUrl to url+.sig", norm && norm.sigUrl === "https://acme.test/index.json.sig");

    // trustedSources: anchor always present; flag source added; anchor name can't be shadowed.
    const flagSpec = `name=acme,url=https://acme.test/index.json,key=${fedPubPem.replace(/\n/g, "\\n")}`;
    const ts = registry.trustedSources({ registryFlags: [flagSpec] });
    check("trustedSources includes 5dive anchor first", ts[0].official === true && ts[0].name === "5dive");
    check("trustedSources adds the federated flag source", ts.some((s) => s.name === "acme"));
    const shadowAttempt = registry.trustedSources({ registryFlags: [`name=5dive,url=https://evil.test/i.json,key=${fedPubPem.replace(/\n/g, "\\n")}`] });
    check("federated source cannot shadow the 5dive anchor name", shadowAttempt.filter((s) => s.name === "5dive").length === 1 && shadowAttempt[0].official === true);

    // fetchSourceLive: mock global.fetch to serve the federated index + sig.
    const origFetch = global.fetch;
    const mk = (body) => ({ ok: true, arrayBuffer: async () => body, text: async () => body.toString("utf8") });
    global.fetch = async (url) => {
      if (url === "https://acme.test/index.json") return mk(fedIndex);
      if (url === "https://acme.test/index.json.sig") return mk(Buffer.from(fedSig));
      if (url === "https://acme.test/forged.sig") return mk(Buffer.from(evilSig));
      throw new Error("unexpected url " + url);
    };
    try {
      const live = await registry.fetchSourceLive(norm);
      check("fetchSourceLive verifies against the source's OWN key", live.signed === true && live.slugs.has("acme-bot"));

      const forgedSrc = registry.normalizeSource({ name: "acme", url: "https://acme.test/index.json", sigUrl: "https://acme.test/forged.sig", publicKey: fedPubPem });
      const forged = await registry.fetchSourceLive(forgedSrc);
      check("fetchSourceLive rejects a sig from a DIFFERENT key (forged → ignored)", forged.signed === false && forged.slugs.size === 0);

      // fetchRegistryIds unions the federated slugs onto the bundled snapshot.
      registry._reset();
      const ids = await registry.fetchRegistryIds({ registryFlags: [flagSpec] });
      check("fetchRegistryIds unions a verified federated slug", ids.has("acme-bot") && ids.has("acme-helper"));

      // A wrong-key flag source confers NOTHING even though the URL serves a valid (other-key) sig.
      registry._reset();
      const wrongKeyFlag = `name=acme,url=https://acme.test/index.json,sig=https://acme.test/forged.sig,key=${fedPubPem.replace(/\n/g, "\\n")}`;
      const idsWrong = await registry.fetchRegistryIds({ registryFlags: [wrongKeyFlag] });
      check("forged federated source confers no Mythical", !idsWrong.has("acme-bot"));
    } finally {
      global.fetch = origFetch;
      registry._reset();
    }
  }

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
  // v0.2: the identity KEY (provenance.created_by.key) is the rarity seed, so it
  // does drive the tier — but only via the key. Stripping all provenance (no
  // key) drops to Ungraded; the signature/lineage fields never move the roll.
  const opsBase = JSON.parse(JSON.stringify(opsDoc));
  delete opsBase.provenance;
  check("removing the identity key → Ungraded",
    computeTier(opsBase, { faceResolved: true, schemaValid: true }).tier === "Ungraded");
  const opsNoSig = JSON.parse(JSON.stringify(opsDoc));
  delete opsNoSig.provenance.signature;
  if (opsNoSig.provenance.derived_from) delete opsNoSig.provenance.derived_from;
  check("signature/lineage don't move the roll (same key → same tier)",
    computeTier(opsNoSig, { faceResolved: true, schemaValid: true }).tier ===
      computeTier(opsDoc, { faceResolved: true, schemaValid: true }).tier);

  // 8b. did:key public address (DIVE-668) — portable, verifiable agent address.
  // base58btc encoder against the canonical "hello world" vector.
  check("base58btc encodes the canonical vector",
    provenance.base58btcEncode(Buffer.from("hello world")) === "StV1DL6CwTryKyV");
  check("base58btc keeps leading-zero bytes as '1'",
    provenance.base58btcEncode(Buffer.from([0, 0, 1])) === "112");
  // Every ed25519 key renders as a did:key:z6Mk… address.
  const didKp = provenance.generateKeypair();
  const did = provenance.didKeyFromPublicKey(didKp.publicKey);
  check("did:key has the ed25519 z6Mk prefix", /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]+$/.test(did));
  // Stable: PEM and bare-base64 DER forms of the same key give the same address.
  const bareB64 = didKp.publicKey.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  check("did:key is form-independent (PEM == bare base64)", provenance.didKeyFromPublicKey(bareB64) === did);
  // Decodes back to 0xed01 multicodec prefix + the raw 32-byte public key.
  const decoded = (() => {
    const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const s = did.slice("did:key:z".length);
    let n = 0n;
    for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
    let hex = n.toString(16);
    if (hex.length % 2) hex = "0" + hex;
    return Buffer.from(hex, "hex");
  })();
  check("did:key decodes to 0xed01 + 32 bytes", decoded.length === 34 && decoded[0] === 0xed && decoded[1] === 0x01);
  check("non-ed25519 input is rejected", (() => {
    try { provenance.didKeyFromPublicKey("not a key"); return false; } catch (_) { return true; }
  })());
  // verify resolves created_by.key → the same did:key the address command prints.
  check("verify resolves the signer's did:key address", opsVerdict.did === provenance.didKeyFromPublicKey(opsDoc.provenance.created_by.key));
  // shortDidKey keeps the multibase marker + tail for the card handle.
  const short = provenance.shortDidKey(did);
  check("shortDidKey keeps z marker + tail", short.startsWith("z…") && did.endsWith(short.slice(2)));
  // Signed personas carry the FRIENDLY id (handle·fingerprint) on the card;
  // unsigned ones stay byte-identical (no fingerprint id).
  const cardWithDid = buildSvg(opsDoc, null, "legendary");
  const opsFriendly = `${opsDoc.id}·${provenance.fingerprintFromDidKey(opsVerdict.did)}`;
  check("signed persona's card shows the friendly id (handle·fingerprint)", cardWithDid.includes(opsFriendly));
  check("signed card no longer shows the raw did tail", !cardWithDid.includes(provenance.shortDidKey(opsVerdict.did)));
  check("unsigned persona's card has no friendly-id fingerprint", !buildSvg(marcusDoc, null, "rare").includes(`${marcusDoc.id}·`));

  // 7b. did:web org verification (lib/org) — fully offline via injected resolver.
  console.log("\n-- org did:web verification --");
  const org = require("../lib/org");

  // did:web <-> well-known URL round trips, incl. paths.
  check("didWebFromUrl: domain", org.didWebFromUrl("https://5dive.com") === "did:web:5dive.com");
  check("didWebFromUrl: path", org.didWebFromUrl("https://5dive.com/teams/research") === "did:web:5dive.com:teams:research");
  check("wellKnownUrlForDid: domain → /.well-known/", org.wellKnownUrlForDid("did:web:5dive.com") === "https://5dive.com/.well-known/openagent.json");
  check("wellKnownUrlForDid: path → path/openagent.json", org.wellKnownUrlForDid("did:web:5dive.com:teams:research") === "https://5dive.com/teams/research/openagent.json");

  // Org keypair + its published well-known doc.
  const orgKp = provenance.generateKeypair();
  const orgDoc = org.buildOrgDoc({ url: "https://5dive.com", name: "5dive", privateKey: orgKp.privateKey, keyId: "org-2026" });
  check("buildOrgDoc carries did + key", orgDoc.did === "did:web:5dive.com" && orgDoc.keys[0].id === "org-2026" && /BEGIN PUBLIC KEY/.test(orgDoc.keys[0].key));

  // A resolver that serves our in-memory org doc — no network.
  const resolve = async (url) => {
    if (url === "https://5dive.com/.well-known/openagent.json") return orgDoc;
    throw new Error("404");
  };

  // Agent persona with a real identity (provenance key), then org-attested.
  const agentKp = provenance.generateKeypair();
  const agentBase = { ...marcusDoc, id: "memberbot", org: { name: "5dive" } };
  const agentSigned = provenance.signPersona(agentBase, { privateKey: agentKp.privateKey, name: "tester" });
  const agentDid = provenance.didKeyFromPublicKey(agentKp.publicKey);
  const block = org.signOrgAttestation(orgKp.privateKey, { agentDid, orgUrl: "https://5dive.com", keyId: "org-2026" });
  check("signOrgAttestation binds the agent did:key", block.agent === agentDid && block.did === "did:web:5dive.com");
  agentSigned.org.verification = block;

  const good = await org.verifyOrgAffiliation(agentSigned, { resolve });
  check("verifyOrgAffiliation: valid attestation verifies", good.verified === true && good.org.name === "5dive" && good.keyId === "org-2026");

  // Tamper 1: attestation bound to a DIFFERENT agent did:key is rejected.
  const otherDid = provenance.didKeyFromPublicKey(provenance.generateKeypair().publicKey);
  const wrongAgent = { ...agentSigned, org: { name: "5dive", verification: org.signOrgAttestation(orgKp.privateKey, { agentDid: otherDid, orgUrl: "https://5dive.com" }) } };
  check("verify rejects attestation for a different agent", (await org.verifyOrgAffiliation(wrongAgent, { resolve })).verified === false);

  // Tamper 2: signature by a key NOT published at the domain is rejected.
  const forgerKp = provenance.generateKeypair();
  const forged = { ...agentSigned, org: { name: "5dive", verification: org.signOrgAttestation(forgerKp.privateKey, { agentDid, orgUrl: "https://5dive.com", keyId: "org-2026" }) } };
  check("verify rejects a forged (unpublished-key) signature", (await org.verifyOrgAffiliation(forged, { resolve })).verified === false);

  // Tamper 3: persona with no provenance identity can't be org-verified.
  const noId = { ...agentBase, org: { name: "5dive", verification: block } };
  delete noId.provenance;
  check("verify rejects persona with no identity to bind", (await org.verifyOrgAffiliation(noId, { resolve })).verified === false);

  // Card: the verified-ORG ✓ appears only when orgVerified is passed.
  check("card shows ✓ only when org-verified", buildSvg(agentSigned, null, "rare", undefined, undefined, { orgVerified: true }).includes("#3DD68C") && !buildSvg(agentSigned, null, "rare").includes("#3DD68C"));

  // Attested persona still validates against the schema.
  check("attested persona still schema-valid", validate(agentSigned).ok === true);

  // 7b. init scaffold — buildPersona() must emit a schema-valid persona, and
  // renderYaml() must round-trip through the YAML parser back to that object.
  console.log("\n-- init wizard --");
  const initLib = require("../lib/init");
  const scaffold = initLib.buildPersona({
    name: "Nova", role: "Support Lead", id: "nova", orgName: "5dive",
    behavior: "answers tickets fast", postsAbout: ["support"],
    faceRef: "./faces/nova.png", faceAnchor: "warm smile",
    voiceRules: ["clear and kind"], voiceSample: "fix is live.",
  });
  check("init scaffold is schema-valid", validate(scaffold).ok === true);
  const initYaml = initLib.renderYaml(scaffold);
  check("init YAML round-trips to a valid persona", validate(YAML.parse(initYaml)).ok === true);
  check("init slugifies names to ids", initLib.slugify("Marcus Ops!") === "marcus-ops");
  check("init omits empty optional blocks", validate(initLib.buildPersona({
    name: "Min", role: "Agent", id: "min", behavior: "does things",
    faceRef: "./faces/min.png", faceAnchor: "neutral",
    voiceRules: ["terse"], voiceSample: "done.",
  })).ok === true);

  // 7b. completenessChecklist — the labeled punch-list `doctor` surfaces.
  const { completenessChecklist } = require("../lib/tier");
  const marcus = load(path.join(examples, "marcus.persona.yaml"));
  const cl = completenessChecklist(marcus);
  check("completenessChecklist returns labeled entries", Array.isArray(cl) && cl.length === 16 &&
    cl.every((c) => c.key && c.label && c.field && typeof c.present === "boolean"));
  check("completenessChecklist marks present + missing fields", cl.find((c) => c.field === "id").present === true &&
    cl.find((c) => c.field === "voice.audio.id").present === false);
  // computeTier's percent must agree with the checklist fraction (no drift).
  const fromList = Math.round((cl.filter((c) => c.present).length / cl.length) * 100);
  check("completeness percent matches checklist fraction",
    computeTier(marcus, { schemaValid: true }).completeness === fromList);

  // 7b. Conformance library (backs `openagent conformance` + `badge --verify`).
  console.log("\n-- conformance library --");
  const { runConformance: runConf, LEVELS, levelsUpTo } = require("../lib/conformance");
  const confAll = runConf();
  check("this impl is fully compliant (all levels pass)", confAll.ok === true && confAll.failures.length === 0);
  check("conformance result carries a structured tally", confAll.total > 0 && confAll.passed === confAll.total);
  const conf01 = runConf("0.1");
  check("level 0.1 runs a subset of all levels", conf01.total <= confAll.total && conf01.ok === true);
  check("levelsUpTo('0.1') excludes 0.2", !levelsUpTo("0.1").includes("0.2") && LEVELS.includes("0.2"));

  // Badge snippet shape — the copy-paste artifact adopters embed.
  check("badge SVG assets are shipped", fs.existsSync(path.join(__dirname, "..", "assets", "badge", "openagent-0.1-compatible.svg")) &&
    fs.existsSync(path.join(__dirname, "..", "assets", "badge", "openagent-0.2-compatible.svg")));
  check("package ships the badge assets dir", require("../package.json").files.includes("assets/"));

  // 8. Conformance suite — run the portable manifest against this impl.
  console.log("\n-- conformance suite --");
  failures += runConformance();

  if (failures) {
    console.log(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log("\nall tests passed");
})();
