#!/usr/bin/env node
"use strict";

const path = require("path");
const { validateFile } = require("../lib/validate");
const { renderCard, renderAnimatedCard, resolveFace, fetchRegistryIds, hasFfmpeg } = require("../lib/card");
const { computeTier, computeBadges, nextRung, rungNeeds, TIER_STYLE } = require("../lib/tier");
const { registryStatus } = require("../lib/registry");
const { speak } = require("../lib/speak");
const { generateKeypair, signPersona, verifyPersona, didKeyFromPublicKey, shortDidKey } = require("../lib/provenance");
const { flow } = require("../lib/flow");
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
const yellow = (s) => c("33", s);

// 256-colour hex -> nearest ansi is overkill; just bold the tier word.
function tierTag(name) {
  return bold(name.toUpperCase());
}

// Offline, synchronous face-resolution check for `validate` — never touches
// the network. A URL ref is taken at face value (the authoritative fetch is
// `tier`/`card`); a local ref must exist on disk. Keeps validate fast enough
// to run over a whole pack in CI.
function faceResolvesOffline(ref, baseDir) {
  const r = typeof ref === "string" ? ref.trim() : "";
  if (!r) return false;
  if (/^https?:\/\//i.test(r)) return true;
  // Mirror resolveFace()'s local candidates: file-relative, then cwd-relative.
  const candidates = path.isAbsolute(r)
    ? [r]
    : [path.resolve(baseDir, r), path.resolve(process.cwd(), r)];
  try {
    return candidates.some((abs) => fs.existsSync(abs));
  } catch (_) {
    return false;
  }
}

const USAGE = `${bold("openagent")} — OpenAgent persona spec tooling (v0.1)

${bold("Usage")}
  openagent validate <persona-file> [<persona-file> ...]
  openagent card <persona-file> [-o <out>] [--format apng|gif|webp|mp4] [--frames N] [--fps N] [--width px]
                                            (animated by default; -o *.png or --static for a still PNG)
  openagent tier <persona-file> [--json]
  openagent registry [--json] [--offline]
  openagent speak <persona-file> "<text>" [-o <out.wav>] [--voice <name>]
  openagent keygen [-o <prefix>]
  openagent address <persona-file | pubkey-file> [--json]
  openagent sign <persona-file> --key <privkey.pem> [--name <n>] [--url <u>] [--derived-from <id[:source]>] [-o <out>]
  openagent verify <persona-file> [--json]
  openagent flow <persona-file> "<scene>" [--json]
  openagent --help
  openagent --version

${bold("validate")}
  Checks a *.persona.yaml (or .json) file against the OpenAgent v0.1
  JSON Schema. Prints a clear pass/fail with readable errors. On a pass it
  also shows the (offline) rarity tier, the exact "next rung" to add to climb
  it, and any collectible badges earned (voice-clone, sprite-sheet, full-body,
  face-recipe, signed, remixed) — badges are orthogonal to the tier ladder.
  Exit code 0 = all valid, 1 = one or more invalid, 2 = usage/IO error.

${bold("card")}
  Renders a shareable "trading card" from a persona: avatar (face.ref), a voice
  waveform from voice.audio (base+style), name, role, the written sample, and the
  computed rarity tier. ${bold("Animated by default")} — a plain render produces the
  card in motion (the holo/foil sweep, glow, and rainbow speckle loop), written to
  <id>.card.mp4 (or .apng without ffmpeg). Motion is TIER-AWARE: Common is still,
  Rare a subtle glow breath, Epic/Legendary a gold foil sweep, Mythical the full
  rainbow holo flow.

  Format picks itself from -o: a video extension (${bold("mp4")}/${bold("gif")}/${bold("webp")}/${bold("apng")})
  animates; ${bold("-o <name>.png")} or ${bold("--static")} writes the still PNG that embeds
  (avatars, READMEs, the registry). mp4/gif/webp need ffmpeg on PATH; apng is the
  zero-dep fallback. For sharing on socials prefer mp4 — it inline-plays
  everywhere and is the smallest. The holo makes one calm pass then rests (~6s
  loop). --frames (default 90 @ --fps 15; apng 30 @ fps 5 since it can't delta-
  compress the static rest), --width (default 720, max 900) tune length/size.
  On the animated render an ${bold("UNSIGNED")} persona is auto-given an identity (a
  keypair is minted, the persona signed in place, the private key saved beside it
  as <id>.key — keep it secret, never commit it) so the card shows a real ROLLED
  rarity instead of Ungraded. ${bold("--no-sign")} skips that; static/--png renders never mint.

${bold("tier")}
  Prints the computed rarity tier + completeness % + the gate breakdown.
  Tiers (gate ladder, highest passing wins): Common < Rare < Epic <
  Legendary < Mythical. Tiers 1-4 are a pure function of the persona file;
  Mythical is conferred by membership in the character-packs registry.

${bold("registry")}
  Shows the official Mythical registry the CLI ships + verifies. Mythical is
  conferred by membership, not farmable from a persona file. The bundled
  snapshot (founding cast) is ed25519-signed and verified against a key baked
  into the CLI; the live character-packs index is unioned on top only if it
  carries a valid signature. --offline skips the network.

${bold("flow")}
  OpenAgent→gen-video adapter: emits a Flow/Veo-ready scene prompt + the
  character reference image(s) that hold the cast face consistent across clips.
  Maps face.ref/full (reference), face.anchor + face.recipe (locked likeness),
  and behavior (demeanor). Engine-neutral (Flow, Veo, Runway, Pika, Kling, Luma).

${bold("speak")}
  OpenAgent→TTS adapter: speaks <text> in the persona's voice. Maps
  voice.audio.base to a Gemini prebuilt voice + voice.audio.style to prompt
  steering; writes a WAV. Needs GEMINI_API_KEY. Renders the BASE voice (an
  approximation); a custom cloned voice (voice.audio.ref/id) is the exact one.

${bold("keygen")}
  Generates a fresh ed25519 identity keypair. Prints the public + private PEM,
  or with -o writes <prefix>.pub / <prefix>.key. The public key IS the author
  identity embedded in a persona; keep the private key secret. Also prints the
  ${bold("did:key")} public address derived from the public key.

${bold("address")}
  Prints the agent's portable PUBLIC ADDRESS as a did:key (W3C standard,
  did:key:z6Mk… = multibase base58btc + ed25519 multicodec) derived from its
  public key. Pass a persona file (reads provenance.created_by.key) or a raw
  ed25519 public-key file (PEM or base64). The did:key is the canonical public
  address; the persona id is a human nickname. --json for scripting.

${bold("sign")}
  Stamps per-file provenance into a persona: embeds your public key under
  provenance.created_by.key, records signed_at, and writes an ed25519 signature
  over the whole file. Pass --derived-from to declare remix lineage (the parent
  you forked). Writes back in place unless -o is given. Proves integrity +
  authorship: the file ships with its own receipt.

${bold("verify")}
  Checks a persona's per-file signature against its embedded public key, and
  prints the author + any remix lineage. Exit 0 = valid signature (or no
  signature present), 1 = a signature that fails to verify (tampered/wrong key).

${bold("Examples")}
  openagent validate marcus.persona.yaml
  openagent card marcus.persona.yaml                           # animated card (mp4) by default
  openagent card marcus.persona.yaml -o marcus.png             # still PNG (for embeds)
  openagent card marcus.persona.yaml --format gif              # pick a specific format
  openagent tier marcus.persona.yaml --json
  openagent registry
  GEMINI_API_KEY=… openagent speak marcus.persona.yaml "ship it." -o marcus.wav
  openagent keygen -o ana
  openagent address vera.persona.yaml          # did:key public address
  openagent sign vera.persona.yaml --key ana.key --name "ana" --derived-from marcus
  openagent verify vera.persona.yaml
  openagent flow marcus.persona.yaml "at his desk reviewing a pull request, late evening"
`;

function loadPersona(file) {
  const raw = fs.readFileSync(file, "utf8");
  return YAML.parse(raw);
}

// Auto-mint an identity for an UNSIGNED persona so its rarity actually rolls.
// Rarity (DIVE-672) is seeded from the did:key, which only exists once a persona
// is signed — so without this, `card` would render *Ungraded* and the whole
// gamification (your rolled tier) never shows. Putting it in the CLI (not skill
// prose) makes it bulletproof: same reasoning as animate-by-default. Mints a
// keypair, signs in place, persists the signed persona (the renderer re-reads
// the file), and saves the private key next to it (0600) so the agent can
// re-sign after edits. CRITICAL: only mints when there is NO created_by.key —
// it NEVER re-keys an already-signed persona (that would change its permanent
// identity and reroll its rarity). Returns whether it minted.
function autoMintIdentity(file) {
  let persona;
  try {
    persona = loadPersona(file);
  } catch {
    return { minted: false };
  }
  const hasKey = !!persona?.provenance?.created_by?.key;
  if (hasKey) return { minted: false };
  const kp = generateKeypair();
  const signed = signPersona(persona, { privateKey: kp.privateKey, signedAt: new Date().toISOString() });
  fs.writeFileSync(file, YAML.stringify(signed));
  const keyfile = file.replace(/\.(persona\.)?ya?ml$/i, "") + ".key";
  fs.writeFileSync(keyfile, kp.privateKey, { mode: 0o600 });
  const did = didKeyFromPublicKey(signed.provenance.created_by.key);
  process.stdout.write(
    `${green("🔑 minted identity")} ${dim(did)}\n` +
    `        ${dim(`private key → ${keyfile} (keep it safe & private; you'll need it to re-sign if you edit the persona)`)}\n`
  );
  return { minted: true, did };
}

async function cmdCard(args) {
  let out = null;
  let checkRegistry = true;
  let animate = false;
  let explicitAnimate = false;     // user passed --animate / --format
  let forceStatic = false;         // user passed --static / --png / --no-animate
  let noSign = false;              // user passed --no-sign (skip auto-mint identity)
  let format = null; // setting --format implies --animate
  let frames = null, fps = null, width = null;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-o" || a === "--out") out = args[++i];
    else if (a === "--no-registry") checkRegistry = false;
    else if (a === "--animate" || a === "--animated") { animate = true; explicitAnimate = true; }
    else if (a === "--static" || a === "--png" || a === "--no-animate") forceStatic = true;
    else if (a === "--no-sign") noSign = true;
    else if (a === "--format" || a === "-f") { format = String(args[++i] || "").toLowerCase(); animate = true; explicitAnimate = true; }
    else if (a === "--frames") frames = parseInt(args[++i], 10);
    else if (a === "--fps") fps = parseInt(args[++i], 10);
    else if (a === "--width") width = parseInt(args[++i], 10);
    else positional.push(a);
  }
  // Animated by default: a plain render produces the moving card — that's what
  // people share. Fall back to a static PNG only when explicitly asked: `--static`,
  // or an `-o` path ending in `.png` (the form embeds, avatars, and the registry
  // use). An `-o` ending in a video extension selects that format.
  if (forceStatic) {
    animate = false;
  } else if (!explicitAnimate) {
    const lo = (out || "").toLowerCase();
    if (lo.endsWith(".png")) animate = false;
    else if (lo.endsWith(".mp4")) { animate = true; format = format || "mp4"; }
    else if (lo.endsWith(".gif")) { animate = true; format = format || "gif"; }
    else if (lo.endsWith(".webp")) { animate = true; format = format || "webp"; }
    else if (lo.endsWith(".apng")) { animate = true; format = format || "apng"; }
    else animate = true; // bare render, or any other ext → default to motion
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

  // Mint an identity so the card shows a real ROLLED rarity instead of Ungraded
  // (rarity is seeded from the did:key, which only exists once signed). Only on
  // the shareable (animated) render and only if not opted out — static/--png
  // renders (embeds, avatars, registry) stay non-mutating. No-op if already signed.
  if (animate && !noSign) autoMintIdentity(file);

  if (animate) {
    const explicitFormat = !!format;
    // Default the share artifact to mp4 when ffmpeg is here — it inline-plays on
    // Telegram/X/Discord and is by far the smallest. APNG is the zero-dep
    // fallback when ffmpeg is absent.
    if (!format) format = hasFfmpeg() ? "mp4" : "apng";
    const res = await renderAnimatedCard(file, out, { checkRegistry, format, frames, fps, width });
    if (!res.ok) {
      process.stderr.write(red(`card: ${res.error}\n`));
      return 2;
    }
    const kb = Math.round(res.bytes / 1024);
    const faceNote = res.faceResolved ? "" : dim(" · no face (monogram)");
    process.stdout.write(
      `${green("✓ CARD")}  ${res.outPath} ${dim(`(${res.format} · ${res.width}×${res.height} · ${res.frames}f@${res.fps}fps · ${kb}KB)`)} — ${tierTag(res.tier)} ${dim(`· ${res.completeness}% complete`)}${faceNote}\n`
    );
    // Steer toward the best share artifact.
    if (res.format === "apng" && res.sharperWithFfmpeg) {
      process.stdout.write(dim(`        ↳ sharing on socials (Telegram/X/Discord)? re-run with --format mp4 — inline-plays everywhere & smaller\n`));
    } else if (res.format === "apng" && !res.sharperWithFfmpeg) {
      process.stdout.write(dim(`        ↳ APNG (zero-dep fallback). Install ffmpeg for --format mp4/gif/webp — smaller & better social autoplay.\n`));
    }
    return 0;
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
  // We only reach here after validateFile passed above, so Common is satisfied.
  const t = computeTier(persona, { faceResolved: face.resolved, inRegistry, schemaValid: true });
  const badges = computeBadges(persona);

  if (json) {
    process.stdout.write(
      JSON.stringify(
        { ok: true, id: persona.id, tier: t.tier, level: t.level, completeness: t.completeness,
          faceResolved: face.resolved, inRegistry, gates: t.gates,
          badges: badges.map((b) => b.key) },
        null, 2
      ) + "\n"
    );
    return 0;
  }

  process.stdout.write(`${tierTag(t.tier)} ${dim(`· ${t.completeness}% complete`)}  ${dim(path.basename(file))}\n`);
  // v0.2: rarity is ROLLED from the persona's did:key — permanent, not a ladder
  // you climb by filling in fields. Show what it is, why, and the one thing you
  // can still climb to (Mythical, by being conferred into the signed registry).
  const prog = rungNeeds();
  if (t.tier === "Ungraded") {
    process.stdout.write(`  ${red("✗")} ${dim("Ungraded — " + prog.ungraded)}\n`);
  } else if (t.tier === "Mythical") {
    process.stdout.write(`  ${green("★")} ${dim("Mythical — conferred by the signed registry. Top of the ladder.")}\n`);
  } else {
    process.stdout.write(`  ${green("✓")} ${dim(`${t.tier} — rolled from your did:key. Permanent; it never changes.`)}\n`);
    const nr = nextRung(t);
    if (nr) process.stdout.write(`  ${dim("↑ only climb:")} ${nr.label} ${dim("— " + nr.need)}\n`);
  }
  // Badges are the parallel collectible chase, orthogonal to rarity.
  writeBadgeLines(badges);
  return 0;
}

// Shared badge renderer: a "🎖 badges:" summary line listing earned keys.
function writeBadgeLines(badges) {
  if (badges.length) {
    process.stdout.write(`  ${dim("🎖  badges:")} ${badges.map((b) => b.key).join(", ")}\n`);
  } else {
    process.stdout.write(`  ${dim("🎖  badges: none yet")}\n`);
  }
}

async function cmdRegistry(args) {
  const json = args.includes("--json");
  const offline = args.includes("--offline");
  const s = await registryStatus({ offline });

  if (json) {
    process.stdout.write(JSON.stringify(s, null, 2) + "\n");
    return s.verified ? 0 : 1;
  }

  if (!s.verified) {
    process.stdout.write(`${red("✗")} bundled registry manifest failed signature verification — no Mythical conferred\n`);
    return 1;
  }
  const liveNote = offline
    ? dim(" (offline)")
    : s.liveSigned
    ? dim(` · live: ${s.live.length} signed`)
    : dim(" · live: unsigned/unavailable → snapshot only");
  process.stdout.write(
    `${green("✓ REGISTRY")} ${dim(`signed ${s.signedAt}, snapshot of ${s.snapshotOf}`)}${liveNote}\n`
  );
  // Eligible = shipped snapshot ∪ verified live.
  const eligible = [...new Set([...s.bundled, ...s.live])].sort();
  process.stdout.write(dim(`  Mythical-eligible (${eligible.length}): `) + eligible.join(", ") + "\n");
  return 0;
}

function cmdKeygen(args) {
  let out = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o" || args[i] === "--out") out = args[++i];
  }
  const kp = generateKeypair();
  const did = didKeyFromPublicKey(kp.publicKey);
  if (out) {
    fs.writeFileSync(`${out}.pub`, kp.publicKey + "\n");
    fs.writeFileSync(`${out}.key`, kp.privateKey + "\n", { mode: 0o600 });
    process.stdout.write(
      `${green("✓ KEYGEN")}  ${out}.pub ${dim("(public — embed in personas)")}\n` +
        `          ${out}.key ${dim("(private — keep secret, never commit)")}\n` +
        `          ${dim("address")} ${did}\n`
    );
    return 0;
  }
  process.stdout.write(`${bold("public address")} ${dim("(did:key — verifiable, portable)")}\n${did}\n\n`);
  process.stdout.write(`${bold("public key")} ${dim("(identity — safe to share / embed)")}\n${kp.publicKey}\n\n`);
  process.stdout.write(`${bold("private key")} ${dim("(KEEP SECRET — never commit)")}\n${kp.privateKey}\n`);
  return 0;
}

// openagent address <persona | pubkey-file> [--json]
// Derives the did:key public address from either a persona's
// provenance.created_by.key or a raw ed25519 public key (PEM / base64).
function cmdAddress(args) {
  const json = args.includes("--json");
  const file = args.find((a) => !a.startsWith("-"));
  if (!file) {
    process.stderr.write(red("address: no persona or public-key file given\n\n") + USAGE);
    return 2;
  }
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: e.message }, null, 2) + "\n");
    else process.stderr.write(red(`address: ${e.message}\n`));
    return 2;
  }
  // Persona doc (object with provenance.created_by.key) vs. a bare key file.
  let key = null,
    source = "public key";
  let doc = null;
  try {
    doc = YAML.parse(raw);
  } catch (_) {
    /* not YAML — treat the file as a raw key below */
  }
  if (doc && typeof doc === "object" && doc.provenance && doc.provenance.created_by && doc.provenance.created_by.key) {
    key = doc.provenance.created_by.key;
    source = "persona created_by.key";
  } else {
    key = raw.trim();
  }
  let did;
  try {
    did = didKeyFromPublicKey(key);
  } catch (e) {
    const msg = `${file} has no derivable ed25519 public address: ${e.message}`;
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: msg }, null, 2) + "\n");
    else process.stderr.write(red(`address: ${msg}\n`));
    return 1;
  }
  if (json) {
    process.stdout.write(JSON.stringify({ ok: true, file, source, did, short: shortDidKey(did) }, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(`${bold("public address")} ${dim(`(did:key · from ${source})`)}\n${did}\n`);
  return 0;
}

function cmdSign(args) {
  let keyPath = null,
    out = null,
    name = null,
    url = null;
  const derived = [];
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--key") keyPath = args[++i];
    else if (a === "-o" || a === "--out") out = args[++i];
    else if (a === "--name") name = args[++i];
    else if (a === "--url") url = args[++i];
    else if (a === "--derived-from") derived.push(args[++i]);
    else positional.push(a);
  }
  const file = positional[0];
  if (!file) {
    process.stderr.write(red("sign: no persona file given\n\n") + USAGE);
    return 2;
  }
  if (!keyPath) {
    process.stderr.write(red("sign: --key <privkey.pem> is required\n"));
    return 2;
  }
  const v = validateFile(file);
  if (!v.ok) {
    process.stdout.write(`${red("✗")} ${file} is not a valid persona — fix it before signing:\n`);
    for (const err of v.errors) process.stdout.write(`        ${red("•")} ${err}\n`);
    return 1;
  }
  let privateKey, persona;
  try {
    privateKey = fs.readFileSync(keyPath, "utf8");
    persona = loadPersona(file);
  } catch (e) {
    process.stderr.write(red(`sign: ${e.message}\n`));
    return 2;
  }
  // --derived-from accepts "id" or "id:source-url".
  if (derived.length) {
    persona.provenance = persona.provenance || {};
    persona.provenance.derived_from = derived.map((d) => {
      const idx = d.indexOf(":");
      if (idx > 0 && /^https?:/.test(d.slice(idx + 1))) {
        return { id: d.slice(0, idx), source: d.slice(idx + 1), relation: "fork" };
      }
      return { id: d, relation: "fork" };
    });
  }
  let signed;
  try {
    signed = signPersona(persona, { privateKey, name, url, signedAt: new Date().toISOString() });
  } catch (e) {
    process.stderr.write(red(`sign: ${e.message}\n`));
    return 2;
  }
  // Re-validate so a malformed --derived-from can't slip a bad file out.
  const recheck = require("../lib/validate").validateDoc(signed);
  if (!recheck.ok) {
    process.stdout.write(`${red("✗")} signed document no longer validates:\n`);
    for (const err of recheck.errors) process.stdout.write(`        ${red("•")} ${err}\n`);
    return 1;
  }
  const target = out || file;
  fs.writeFileSync(target, YAML.stringify(signed));
  const lin = signed.provenance.derived_from
    ? dim(` · derived from ${signed.provenance.derived_from.map((d) => d.id).join(", ")}`)
    : "";
  process.stdout.write(`${green("✓ SIGNED")} ${target} ${dim(`· by ${name || "anon"}`)}${lin}\n`);
  return 0;
}

function cmdVerify(args) {
  const json = args.includes("--json");
  const file = args.find((a) => !a.startsWith("-"));
  if (!file) {
    process.stderr.write(red("verify: no persona file given\n\n") + USAGE);
    return 2;
  }
  let persona;
  try {
    persona = loadPersona(file);
  } catch (e) {
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: e.message }, null, 2) + "\n");
    else process.stderr.write(red(`verify: ${e.message}\n`));
    return 2;
  }
  const r = verifyPersona(persona);
  if (json) {
    process.stdout.write(JSON.stringify({ file, ...r }, null, 2) + "\n");
    return r.signed && !r.ok ? 1 : 0;
  }
  if (!r.signed) {
    process.stdout.write(`${dim("○ UNSIGNED")} ${file} ${dim("— no per-file provenance (valid, but unproven)")}\n`);
    return 0;
  }
  if (!r.ok) {
    process.stdout.write(`${red("✗ INVALID")} ${file} ${dim("— " + r.reason)}\n`);
    return 1;
  }
  const who = (r.createdBy && (r.createdBy.name || r.createdBy.url)) || "anonymous key";
  process.stdout.write(`${green("✓ VERIFIED")} ${file} ${dim(`· signed by ${who}`)}\n`);
  if (r.did) process.stdout.write(`  ${dim("address")} ${r.did}\n`);
  if (r.derivedFrom && r.derivedFrom.length) {
    for (const d of r.derivedFrom) {
      process.stdout.write(`  ${dim("↳ " + (d.relation || "fork") + " of")} ${d.id}${d.source ? dim(` (${d.source})`) : ""}\n`);
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
      // Offline tier estimate + the exact "next rung" to chase, so validate
      // doubles as a completeness quest, not just a pass/fail gate. Registry
      // (Mythical) is never probed here — that's `tier`'s networked job.
      let tierNote = "", quest = [];
      try {
        const persona = loadPersona(file);
        const faceResolved = faceResolvesOffline(persona.face?.ref, path.dirname(path.resolve(file)));
        const t = computeTier(persona, { faceResolved, schemaValid: true });
        const badges = computeBadges(persona);
        tierNote = ` — ${tierTag(t.tier)} ${dim(`· ${t.completeness}% complete`)}`;
        const nr = nextRung(t);
        if (nr) quest.push(`        ${dim("↑ next:")} ${nr.label} ${dim(`— ${nr.need}`)}`);
        else quest.push(`        ${dim("★ top of the ladder")}`);
        quest.push(
          badges.length
            ? `        ${dim("🎖  badges:")} ${badges.map((b) => b.key).join(", ")}`
            : `        ${dim("🎖  badges: none yet")}`
        );
      } catch (_) {
        // A file that validates but can't be re-parsed is impossible in
        // practice; degrade silently to the plain PASS line.
      }
      process.stdout.write(`${green("✓ PASS")}  ${rel}${idNote}${tierNote}\n`);
      for (const line of quest) process.stdout.write(line + "\n");
      for (const w of res.warnings || []) process.stdout.write(`        ${yellow("⚠")} ${w}\n`);
    } else {
      invalidCount++;
      if (res.errors.length === 1 && /^cannot read file:/.test(res.errors[0])) anyIoError = true;
      process.stdout.write(`${red("✗ FAIL")}  ${rel}\n`);
      for (const err of res.errors) process.stdout.write(`        ${red("•")} ${err}\n`);
      for (const w of res.warnings || []) process.stdout.write(`        ${yellow("⚠")} ${w}\n`);
    }
  }
  if (files.length > 1) {
    process.stdout.write(dim(`\n${files.length - invalidCount}/${files.length} valid\n`));
  }
  if (invalidCount > 0) return anyIoError && files.length === 1 ? 2 : 1;
  return 0;
}

async function cmdSpeak(args) {
  let out = null, voice = null, model = null;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o") out = args[++i];
    else if (args[i] === "--voice") voice = args[++i];
    else if (args[i] === "--model") model = args[++i];
    else pos.push(args[i]);
  }
  const [file, text] = pos;
  if (!file || !text) {
    process.stderr.write(red('speak: usage: openagent speak <persona-file> "<text>" [-o out.wav]\n\n') + USAGE);
    return 2;
  }
  const v = validateFile(file);
  if (!v.ok) {
    process.stdout.write(`${red("✗")} ${file} is not a valid persona:\n`);
    for (const err of v.errors) process.stdout.write(`        ${red("•")} ${err}\n`);
    return 1;
  }
  const r = await speak(file, text, { out, voice, model });
  if (r.error) { process.stderr.write(red(`speak: ${r.error}\n`)); return 1; }
  const kb = (r.bytes / 1024).toFixed(0);
  process.stdout.write(`${green("✓ SPOKE")}  ${r.outPath} ${dim(`(${kb}KB, voice: ${r.voice}${r.styled ? " + style" : ""})`)}\n`);
  return 0;
}

async function cmdFlow(args) {
  const json = args.includes("--json");
  const pos = args.filter((a) => !a.startsWith("-"));
  const [file, scene] = pos;
  if (!file || !scene) {
    process.stderr.write(red('flow: usage: openagent flow <persona-file> "<scene>" [--json]\n\n') + USAGE);
    return 2;
  }
  const v = validateFile(file);
  if (!v.ok) {
    process.stdout.write(`${red("✗")} ${file} is not a valid persona:\n`);
    for (const err of v.errors) process.stdout.write(`        ${red("•")} ${err}\n`);
    return 1;
  }
  const r = flow(file, scene);
  if (r.error) { process.stderr.write(red(`flow: ${r.error}\n`)); return 1; }
  if (json) { process.stdout.write(JSON.stringify(r, null, 2) + "\n"); return 0; }
  process.stdout.write(`${green("✓ FLOW")}  ${r.name}${r.role ? dim(" — " + r.role) : ""} ${dim("· paste into Flow/Veo")}\n\n`);
  if (r.refs.length) {
    process.stdout.write(`${bold("character reference")}\n`);
    for (const ref of r.refs) process.stdout.write(`  ${ref}\n`);
    process.stdout.write("\n");
  }
  process.stdout.write(`${bold("prompt")}\n${r.prompt}\n`);
  if (r.model || r.seed != null) process.stdout.write(`\n${dim(`model: ${r.model || "-"}   seed: ${r.seed != null ? r.seed : "-"}`)}\n`);
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
  if (cmd === "registry") return cmdRegistry(rest);
  if (cmd === "speak") return cmdSpeak(rest);
  if (cmd === "keygen") return cmdKeygen(rest);
  if (cmd === "address") return cmdAddress(rest);
  if (cmd === "sign") return cmdSign(rest);
  if (cmd === "verify") return cmdVerify(rest);
  if (cmd === "flow") return cmdFlow(rest);

  process.stderr.write(red(`unknown command: ${cmd}\n\n`) + USAGE);
  return 2;
}

main(process.argv).then((code) => process.exit(code)).catch((e) => {
  process.stderr.write(red(`error: ${e.stack || e.message}\n`));
  process.exit(2);
});
