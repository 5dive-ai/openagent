#!/usr/bin/env node
"use strict";

const path = require("path");
const { validateFile } = require("../lib/validate");
const { renderCard, renderAnimatedCard, resolveFace, materializeHandle, fetchRegistryIds, hasFfmpeg } = require("../lib/card");
const { computeTier, computeBadges, nextRung, rungNeeds, completenessChecklist, TIER_STYLE } = require("../lib/tier");
const { registryStatus } = require("../lib/registry");
const { speak } = require("../lib/speak");
const { generateKeypair, signPersona, verifyPersona, didKeyFromPublicKey, shortDidKey, friendlyId, verifyFriendlyId } = require("../lib/provenance");
const { flow } = require("../lib/flow");
const { runInit } = require("../lib/init");
const { loadAgentKey, loadOrCreateAgentKey, agentKeyPath } = require("../lib/keystore");
const YAML = require("yaml");
const fs = require("fs");

const pkg = require("../package.json");

// Collect repeatable `--registry <spec>` flags (federated Mythical registries,
// DIVE-689). Each spec is `name=acme,url=...,key=@/path/to.pub[,sig=...]` and is
// forwarded verbatim to lib/registry, which verifies each source's index
// against its own declared key. Returns [] when none given.
function registryFlagsFrom(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--registry" && args[i + 1]) out.push(args[++i]);
  }
  return out;
}

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
  openagent init [-o <file>] [--name <n>] [--role <r>] [--id <id>] [--org <o>] [--force]
  openagent validate <persona-file> [<persona-file> ...]
  openagent card <persona-file>|--handle <slug> [-o <out>] [--format apng|gif|webp|mp4] [--frames N] [--fps N] [--width px]
                                            (animated by default; -o *.png or --static for a still PNG)
                                            (--handle renders the OFFICIAL signed card straight from the registry)
  openagent tier <persona-file> [--json]
  openagent registry [--json] [--offline]
  openagent speak <persona-file> "<text>" [-o <out.wav>] [--voice <name>]
  openagent keygen [-o <prefix>]
  openagent address <persona-file | pubkey-file> [--json]
  openagent id <persona-file | pubkey-file> [--handle <h>] [--check <claim>] [--json]
  openagent sign <persona-file> [--key <privkey.pem>] [--name <n>] [--url <u>] [--derived-from <id[:source]>] [-o <out>]
                                            (no --key → signs with the agent keystore key, ~/.openagent/agent.key)
  openagent verify <persona-file> [--json]
  openagent doctor <persona-file> [--json] [--no-registry]
  openagent org init   --url <org> --name <Org> --key <orgpriv.key> [--key-id <id>] [-o openagent.json]
  openagent org attest <persona-file> --key <orgpriv.key> (--url <org> | --did <did:web>) [--key-id <id>] [-o <out>]
  openagent org verify <persona-file> [--json]
  openagent flow <persona-file> "<scene>" [--engine <name>] [--json]
  openagent --help
  openagent --version

${bold("init")}
  Interactive Q&A that scaffolds a schema-valid <id>.persona.yaml — answer a
  handful of plain questions (name, role, voice, face) and get a file you can
  validate + render a card from immediately. Defaults shown in [brackets];
  press enter to accept. Flags pre-fill answers for a faster path. Writes
  <id>.persona.yaml (or -o <file>); refuses to clobber unless --force.

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

  ${bold("--handle <slug>")} renders an agent's OFFICIAL card straight from the trusted
  registry: it fetches the SIGNED persona + avatar (e.g. olivia, marcus) and renders
  the exact card the gallery shows — same did:key, tier, and monogram. Use this for
  content/marketing instead of hand-assembling raw URLs or rendering a local working
  copy, which re-mints a WRONG identity. The persona is never mutated (no auto-mint).

  Format picks itself from -o: a video extension (${bold("mp4")}/${bold("gif")}/${bold("webp")}/${bold("apng")})
  animates; ${bold("-o <name>.png")} or ${bold("--static")} writes the still PNG that embeds
  (avatars, READMEs, the registry); ${bold("-o <name>.svg")} writes the vector card.
  PNG/animation use the optional ${bold("@resvg/resvg-js")} rasterizer — if it isn't
  installed, use ${bold("-o <name>.svg")} (no rasterizer needed) or ${bold("npm i @resvg/resvg-js")}.
  mp4/gif/webp also need ffmpeg on PATH; apng is the zero-dep raster fallback. For
  sharing on socials prefer mp4 — it inline-plays everywhere and is the smallest.
  The holo makes one calm pass then rests (~6s loop). --frames (default 90 @ --fps
  15; apng 30 @ fps 5 since it can't delta-compress the static rest), --width
  (default 720, max 900) tune length/size.
  On the animated render an ${bold("UNSIGNED")} persona is auto-given an identity (a
  keypair is minted, the persona signed in place, the private key saved beside it
  as <id>.key — keep it secret, never commit it) so the card shows a real ROLLED
  rarity instead of Ungraded. ${bold("--no-sign")} skips that; static/--png renders never mint.

${bold("tier")}
  Prints the computed rarity tier + completeness % + the gate breakdown.
  Tiers (gate ladder, highest passing wins): Common < Rare < Epic <
  Legendary < Mythical. Tiers 1-4 are a pure function of the persona file;
  Mythical is conferred by membership in any trusted signed registry.

${bold("registry")} [--json] [--offline] [--registry <spec>]
  Shows the trusted Mythical registries the CLI verifies. Mythical is conferred
  by membership in ANY trusted signed registry, not farmable from a persona file.
  The bundled 5dive snapshot (founding cast) is ed25519-signed and verified
  against a key baked into the CLI; each live registry index is unioned on top
  only if it carries a valid signature against THAT source's own key.
  FEDERATED: anyone can run their own signed registry. Add trusted sources via
  ~/.openagent/registries.json ({ "registries": [{name,url,publicKey|publicKeyPath,sigUrl?}] }),
  the OPENAGENT_REGISTRIES env (inline JSON or a path), or repeatable
  --registry name=acme,url=https://…/index.json,key=@/path/to.pub[,sig=…].
  The same --registry flag works on ${bold("tier")} and ${bold("card")}. --offline skips the network.

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

${bold("doctor")}
  One end-to-end pre-flight before you share or PR a persona. Rolls every other
  check into a single punch-list, each line with an actionable fix-it:
  schema-valid, identity signed (did:key) + signature actually verifies, face.ref
  reachable (live fetch), rolled rarity tier + Mythical conferral, earned badges,
  and the completeness surface with the EXACT missing fields named. Exit 0 =
  healthy (advisory warnings allowed), 1 = a hard defect (invalid schema or a
  broken signature), 2 = usage/IO error. --json emits the full machine report;
  --no-registry skips the (network) Mythical-conferral lookup.

${bold("handshake")}
  Prove who you are to another agent, live (A2A). present → your did:key + public
  key (+ optional --handle/--url to resolve against a signed registry); challenge →
  a fresh nonce; respond <nonce> → sign it with your keystore key; verify
  --presentation <file> --nonce --signature → checks the did derives from the key
  AND the signature is live. Exit 0 = key ownership proven, 1 = not. JSON in/out.

${bold("receipt")}
  Co-signed work receipts — the verifiable edge between two agents. sign --task
  --result --to <did> [--at] → a receipt from you, signed once; cosign <file> → add
  your signature to a partial; verify <file> → both sigs valid over the body (exit
  0/1); history <file.jsonl> → your earned ledger (verified receipts, distinct
  counterparties). No chain, no token: two signatures = both attest it happened.

${bold("Examples")}
  openagent validate marcus.persona.yaml
  openagent card marcus.persona.yaml                           # animated card (mp4) by default
  openagent card marcus.persona.yaml -o marcus.png             # still PNG (for embeds)
  openagent card marcus.persona.yaml --format gif              # pick a specific format
  openagent card --handle olivia -o olivia.mp4                 # OFFICIAL signed card from the registry
  openagent tier marcus.persona.yaml --json
  openagent registry
  GEMINI_API_KEY=… openagent speak marcus.persona.yaml "ship it." -o marcus.wav
  openagent keygen -o ana
  openagent address vera.persona.yaml          # did:key public address
  openagent sign vera.persona.yaml --key ana.key --name "ana" --derived-from marcus
  openagent verify vera.persona.yaml
  openagent doctor marcus.persona.yaml                         # full pre-flight before sharing/PR
  openagent flow marcus.persona.yaml "at his desk reviewing a pull request, late evening"
  openagent handshake present > me.json                        # A2A: prove who you are, live
  openagent receipt sign --task "build login fix" --result "PR #214 merged" --to did:key:z6Mk…
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
  // Sign with the agent's STABLE keystore identity (DIVE-730) — one key per
  // agent (~/.openagent/agent.key), provisioned on first use — so all of an
  // agent's cards share one did:key instead of a fresh ephemeral key per file.
  const kp = loadOrCreateAgentKey();
  const signed = signPersona(persona, { privateKey: kp.privateKey, signedAt: new Date().toISOString() });
  fs.writeFileSync(file, YAML.stringify(signed));
  const did = didKeyFromPublicKey(signed.provenance.created_by.key);
  const fid = friendlyId(signed.id || "", did).display; // e.g. olivia·z6Mk… → olivia·z8jrr2
  process.stdout.write(
    `${green(kp.created ? "🔑 minted identity" : "🔑 signed as")} ${bold(fid)} ${dim(`(${did})`)}\n` +
    `        ${dim(`agent key ${kp.created ? "created at" : "→"} ${kp.path} (0600 — keep it private; all your cards sign with this one identity)`)}\n`
  );
  return { minted: true, did, fid };
}

async function cmdCard(args) {
  let out = null;
  let checkRegistry = true;
  const registryFlags = registryFlagsFrom(args);
  let animate = false;
  let explicitAnimate = false;     // user passed --animate / --format
  let forceStatic = false;         // user passed --static / --png / --no-animate
  let noSign = false;              // user passed --no-sign (skip auto-mint identity)
  let format = null; // setting --format implies --animate
  let frames = null, fps = null, width = null;
  let handle = null;              // user passed --handle <slug> (render official signed card)
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-o" || a === "--out") out = args[++i];
    else if (a === "--registry") i++; // federated source spec, collected below
    else if (a === "--no-registry") checkRegistry = false;
    else if (a === "--animate" || a === "--animated") { animate = true; explicitAnimate = true; }
    else if (a === "--static" || a === "--png" || a === "--no-animate") forceStatic = true;
    else if (a === "--no-sign") noSign = true;
    else if (a === "--handle") handle = String(args[++i] || "").trim();
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
    else if (lo.endsWith(".svg")) animate = false; // vector, resvg-free
    else if (lo.endsWith(".mp4")) { animate = true; format = format || "mp4"; }
    else if (lo.endsWith(".gif")) { animate = true; format = format || "gif"; }
    else if (lo.endsWith(".webp")) { animate = true; format = format || "webp"; }
    else if (lo.endsWith(".apng")) { animate = true; format = format || "apng"; }
    else animate = true; // bare render, or any other ext → default to motion
  }
  // --handle <slug>: render the OFFICIAL signed card straight from the registry.
  // Resolves + downloads the SIGNED persona (and its avatar) into a temp dir, so
  // the card matches the gallery exactly — never re-mints a wrong identity from an
  // incomplete local working copy. Auto-mint is force-off (the registry persona is
  // already signed; we never mutate it).
  let file;
  if (handle) {
    if (positional.length) {
      process.stderr.write(red("card: pass either --handle <slug> or a persona file, not both\n"));
      return 2;
    }
    process.stderr.write(dim(`resolving @${handle} from the registry…\n`));
    const m = await materializeHandle(handle, { registryFlags });
    if (!m.ok) {
      process.stderr.write(red(`card: ${m.error}\n`));
      if (m.available && m.available.length) {
        process.stderr.write(dim(`        known handles: ${m.available.join(", ")}\n`));
      }
      return 2;
    }
    file = m.file;
    noSign = true; // signed registry persona — render as-is, never mint
  } else if (positional.length === 0) {
    process.stderr.write(red("card: no persona file given (or use --handle <slug>)\n\n") + USAGE);
    return 2;
  } else {
    file = positional[0];
  }
  const v = validateFile(file);
  if (!v.ok) {
    process.stdout.write(`${red("✗")} ${file} is not a valid persona — fix it first:\n`);
    for (const err of v.errors) process.stdout.write(`        ${red("•")} ${err}\n`);
    return 1;
  }
  // Non-fatal advisories (placeholder org, missing version) — the card prints
  // org.name verbatim, so flag a left-in placeholder before it ships on the card.
  for (const w of v.warnings || []) process.stdout.write(`${yellow("⚠")} ${w}\n`);

  // Mint an identity so the card shows a real ROLLED rarity instead of Ungraded
  // (rarity is seeded from the did:key, which only exists once signed). Only on
  // the shareable (animated) render and only if not opted out — static/--png
  // renders (embeds, avatars, registry) stay non-mutating. No-op if already signed.
  if (animate && !noSign) autoMintIdentity(file);

  // Friendly id (handle·fingerprint) for the success line — matches the card
  // footer + `openagent id`. Signed personas only; blank otherwise.
  let fidTag = "";
  try {
    const p = loadPersona(file);
    const k = p && p.provenance && p.provenance.created_by && p.provenance.created_by.key;
    if (k) fidTag = `${bold(friendlyId(p.id || "", didKeyFromPublicKey(k)).display)} · `;
  } catch (_) { /* unsigned → no id tag */ }

  if (animate) {
    const explicitFormat = !!format;
    // Default the share artifact to mp4 when ffmpeg is here — it inline-plays on
    // Telegram/X/Discord and is by far the smallest. APNG is the zero-dep
    // fallback when ffmpeg is absent.
    if (!format) format = hasFfmpeg() ? "mp4" : "apng";
    const res = await renderAnimatedCard(file, out, { checkRegistry, registryFlags, format, frames, fps, width });
    if (!res.ok) {
      process.stderr.write(red(`card: ${res.error}\n`));
      return 2;
    }
    const kb = Math.round(res.bytes / 1024);
    const faceNote = res.faceResolved ? "" : dim(" · no face (monogram)");
    process.stdout.write(
      `${green("✓ CARD")}  ${res.outPath} ${dim(`(${res.format} · ${res.width}×${res.height} · ${res.frames}f@${res.fps}fps · ${kb}KB)`)} — ${tierTag(res.tier)} ${dim(`· ${res.completeness}% complete`)}${faceNote}\n`.replace("— ", `— ${fidTag}`)
    );
    // Steer toward the best share artifact.
    if (res.format === "apng" && res.sharperWithFfmpeg) {
      process.stdout.write(dim(`        ↳ sharing on socials (Telegram/X/Discord)? re-run with --format mp4 — inline-plays everywhere & smaller\n`));
    } else if (res.format === "apng" && !res.sharperWithFfmpeg) {
      process.stdout.write(dim(`        ↳ APNG (zero-dep fallback). Install ffmpeg for --format mp4/gif/webp — smaller & better social autoplay.\n`));
    }
    return 0;
  }

  // Best-effort did:web org verification for the verified-ORG ✓ on the card.
  // Gated on the same network flag as the registry check; failures stay silent
  // (the card just renders without the badge) so offline/down domains never
  // block a render.
  let orgVerified = false;
  if (checkRegistry) {
    try {
      const org = require("../lib/org");
      const persona = loadPersona(file);
      if (persona.org && persona.org.verification) {
        orgVerified = (await org.verifyOrgAffiliation(persona, { resolve: org.fetchResolver })).verified === true;
      }
    } catch (_) {
      /* offline / unreachable domain → no badge */
    }
  }
  const res = await renderCard(file, out, { checkRegistry, registryFlags, orgVerified });
  if (!res.ok) {
    process.stderr.write(red(`card: ${res.error}\n`));
    return 2;
  }
  const kb = Math.round(res.bytes / 1024);
  const faceNote = res.faceResolved ? "" : dim(" · no face (monogram)");
  process.stdout.write(
    `${green("✓ CARD")}  ${res.outPath} ${dim(`(${res.width}×${res.height}, ${kb}KB)`)} — ${tierTag(res.tier)} ${dim(`· ${res.completeness}% complete`)}${faceNote}\n`.replace("— ", `— ${fidTag}`)
  );
  return 0;
}

async function cmdTier(args) {
  const json = args.includes("--json");
  let checkRegistry = !args.includes("--no-registry");
  const registryFlags = registryFlagsFrom(args);
  // Drop `--registry` and its consumed spec value before hunting for the file.
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--registry") { i++; continue; }
    rest.push(args[i]);
  }
  const file = rest.find((a) => !a.startsWith("-"));
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
  if (checkRegistry) inRegistry = (await fetchRegistryIds({ registryFlags })).has(persona.id);
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
  const registryFlags = registryFlagsFrom(args);
  const s = await registryStatus({ offline, registryFlags });

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
  // Federated sources (DIVE-689): each trusted source verified against its own
  // key. The 5dive anchor is always present; show any others the operator added.
  const federated = (s.sources || []).filter((src) => !src.official);
  if (federated.length) {
    process.stdout.write(dim(`  trusted sources (${s.sources.length}):\n`));
    for (const src of s.sources) {
      const mark = offline
        ? dim("·")
        : src.signed
        ? green("✓")
        : src.reachable
        ? yellow("⚠")
        : dim("✗");
      const note = offline
        ? dim("(offline)")
        : src.signed
        ? dim(`${src.slugs.length} signed`)
        : src.reachable
        ? dim("unsigned/forged → ignored")
        : dim("unreachable");
      const tag = src.official ? dim(" (anchor)") : "";
      process.stdout.write(`    ${mark} ${src.name}${tag} ${note}\n`);
    }
  }
  // Eligible = shipped snapshot ∪ verified live from EVERY trusted source.
  const allLive = (s.sources || []).flatMap((src) => src.slugs);
  const eligible = [...new Set([...s.bundled, ...s.live, ...allLive])].sort();
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

// openagent id <persona | pubkey-file> [--handle h] [--check claim] [--json]
// Friendly ID = handle·fingerprint (e.g. marcus·k7f2q9): the persona id paired
// with a short fingerprint derived from the did:key. Memorable + collision-safe
// + verifiable. --check verifies a claimed friendly id against the key.
function cmdId(args) {
  const json = args.includes("--json");
  let handleOverride = null, check = null;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") continue;
    else if (a === "--handle") handleOverride = args[++i];
    else if (a === "--check") check = args[++i];
    else if (!a.startsWith("-")) positional.push(a);
  }
  const file = positional[0];
  if (!file) {
    process.stderr.write(red("id: no persona or public-key file given\n\n") + USAGE);
    return 2;
  }
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: e.message }, null, 2) + "\n");
    else process.stderr.write(red(`id: ${e.message}\n`));
    return 2;
  }
  let doc = null;
  try { doc = YAML.parse(raw); } catch (_) { /* raw key file */ }
  let key, handle;
  if (doc && typeof doc === "object" && doc.provenance && doc.provenance.created_by && doc.provenance.created_by.key) {
    key = doc.provenance.created_by.key;
    handle = handleOverride || doc.id;
  } else {
    key = raw.trim();
    handle = handleOverride;
  }
  let did;
  try {
    did = didKeyFromPublicKey(key);
  } catch (e) {
    const msg = `${file} has no did:key yet — sign/mint first (render a card, or \`openagent sign\`). ${e.message}`;
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: msg }, null, 2) + "\n");
    else process.stderr.write(red(`id: ${msg}\n`));
    return 1;
  }
  if (!handle) {
    const msg = "no handle — a persona file supplies it via `id`, or pass --handle <name> for a bare key file";
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: msg }, null, 2) + "\n");
    else process.stderr.write(red(`id: ${msg}\n`));
    return 2;
  }

  if (check != null) {
    const v = verifyFriendlyId(check, did, handle);
    if (json) {
      process.stdout.write(JSON.stringify({ ok: v.ok, claimed: check, handle, did, fingerprint: v.fingerprint, reason: v.reason }, null, 2) + "\n");
    } else if (v.ok) {
      process.stdout.write(`${green("✓")} ${bold(check)} ${dim("verified — fingerprint matches the did:key")}\n`);
    } else {
      process.stdout.write(`${red("✗")} ${bold(check)} ${dim("— " + v.reason)}\n   ${dim("correct id:")} ${handle}·${v.fingerprint}\n`);
    }
    return v.ok ? 0 : 1;
  }

  const fid = friendlyId(handle, did);
  if (json) {
    process.stdout.write(JSON.stringify({ ok: true, id: handle, did, fingerprint: fid.fingerprint, display: fid.display, urlSafe: fid.urlSafe }, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(`${bold(fid.display)}  ${dim("(handle·fingerprint — share this)")}\n`);
  process.stdout.write(`${dim("url-safe ")}${fid.urlSafe}\n`);
  process.stdout.write(`${dim("did:key  ")}${did}\n`);
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
  const v = validateFile(file);
  if (!v.ok) {
    process.stdout.write(`${red("✗")} ${file} is not a valid persona — fix it before signing:\n`);
    for (const err of v.errors) process.stdout.write(`        ${red("•")} ${err}\n`);
    return 1;
  }
  // --key wins; otherwise fall back to a legacy persona-adjacent <id>.key if one
  // exists, then to the agent's keystore identity (DIVE-730), creating it on
  // first use. So `openagent sign <file>` just works with the agent's own key.
  let privateKey, persona, keySrc;
  try {
    if (!keyPath) {
      const adjacent = file.replace(/\.(persona\.)?ya?ml$/i, "") + ".key";
      if (fs.existsSync(adjacent)) keyPath = adjacent;
    }
    if (keyPath) {
      privateKey = fs.readFileSync(keyPath, "utf8");
      keySrc = keyPath;
    } else {
      const kp = loadOrCreateAgentKey();
      privateKey = kp.privateKey;
      keySrc = kp.path + (kp.created ? " (new agent key)" : "");
    }
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
  process.stdout.write(`${green("✓ SIGNED")} ${target} ${dim(`· by ${name || "anon"} · key ${keySrc}`)}${lin}\n`);
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

// openagent doctor <persona> — one end-to-end pre-flight before you share/PR a
// persona. Composes every other check into a single punch-list: schema-valid,
// identity signed (did:key) + signature actually verifies, face.ref reachable
// (live fetch), rolled tier + conferred Mythical, earned badges, and the
// completeness surface with the exact missing fields named. Each line carries
// an actionable fix-it. Exit 0 = healthy (warnings allowed), 1 = a hard defect
// (invalid schema or a broken signature), 2 = usage/IO. --json for machines.
async function cmdDoctor(args) {
  const json = args.includes("--json");
  const checkRegistry = !args.includes("--no-registry");
  const registryFlags = registryFlagsFrom(args);
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--registry") { i++; continue; }
    rest.push(args[i]);
  }
  const file = rest.find((a) => !a.startsWith("-"));
  if (!file) {
    process.stderr.write(red("doctor: no persona file given\n\n") + USAGE);
    return 2;
  }

  let persona;
  try {
    persona = loadPersona(file);
  } catch (e) {
    if (json) process.stdout.write(JSON.stringify({ file, ok: false, error: e.message }, null, 2) + "\n");
    else process.stderr.write(red(`✗ ${file} — could not parse: ${e.message}\n`));
    return 2;
  }

  // Gather every signal. Network checks (face fetch, registry) are best-effort.
  const v = validateFile(file);
  const ver = verifyPersona(persona);
  const baseDir = path.dirname(path.resolve(file));
  const face = await resolveFace(persona && persona.face ? persona.face.ref : null, baseDir);
  let inRegistry = false;
  if (checkRegistry) {
    try { inRegistry = (await fetchRegistryIds({ registryFlags })).has(persona && persona.id); }
    catch (_) { /* offline / unreachable → not conferred, no crash */ }
  }
  const t = computeTier(persona, { faceResolved: face.resolved, inRegistry, schemaValid: v.ok });
  const badges = computeBadges(persona, { signatureValid: ver.signed ? ver.ok : undefined });
  const checklist = completenessChecklist(persona);
  const missing = checklist.filter((c) => !c.present);

  // status ∈ ok | warn | fail. fail is the only thing that fails the exit code.
  const checks = [];

  // 1. Schema
  checks.push({
    id: "schema",
    status: v.ok ? "ok" : "fail",
    label: "Schema",
    detail: v.ok ? "valid against the OpenAgent persona schema" : `${v.errors.length} schema error(s)`,
    fixes: v.ok ? [] : v.errors,
  });
  if ((v.warnings || []).length) {
    checks.push({ id: "warnings", status: "warn", label: "Warnings",
      detail: `${v.warnings.length} advisory warning(s)`, fixes: v.warnings });
  }

  // 2. Identity + signature (did:key)
  if (!ver.signed) {
    checks.push({ id: "signed", status: "warn", label: "Identity",
      detail: "unsigned — valid but unproven, and rarity stays Ungraded",
      fixes: ["render a card (auto-mints a did:key) or run `openagent sign <file> --key <privkey>`"] });
  } else if (!ver.ok) {
    checks.push({ id: "signed", status: "fail", label: "Identity",
      detail: `signature INVALID — ${ver.reason}`,
      fixes: ["re-sign after your edits: `openagent sign <file> --key <privkey>` (the content changed since it was signed)"] });
  } else {
    checks.push({ id: "signed", status: "ok", label: "Identity",
      detail: `signed & verified · ${ver.did || "did:key"}`, fixes: [] });
  }

  // 3. face.ref reachable (authoritative live resolution)
  const faceRef = persona && persona.face ? persona.face.ref : null;
  if (!faceRef) {
    checks.push({ id: "face", status: "warn", label: "Face",
      detail: "no face.ref — the card falls back to a monogram",
      fixes: ["add face.ref (a URL or local image path) so the card shows your likeness"] });
  } else if (face.resolved) {
    checks.push({ id: "face", status: "ok", label: "Face",
      detail: `face.ref resolves (${String(faceRef).slice(0, 60)})`, fixes: [] });
  } else {
    checks.push({ id: "face", status: "fail", label: "Face",
      detail: `face.ref does NOT resolve to an image (${String(faceRef).slice(0, 60)})`,
      fixes: ["fix the path/URL — a local ref must exist on disk; a URL must return an image content-type"] });
  }

  // 4. Tier (rolled) + Mythical conferral
  checks.push({ id: "tier", status: t.tier === "Ungraded" ? "warn" : "ok", label: "Tier",
    detail: t.tier === "Ungraded"
      ? "Ungraded — sign the persona to roll a permanent rarity"
      : t.tier === "Mythical"
      ? "Mythical — conferred by the signed registry"
      : `${t.tier} — rolled from your did:key (permanent)`,
    fixes: t.tier === "Ungraded" ? [rungNeeds().ungraded] : [] });

  // 5. Badges (collectibles, orthogonal to tier)
  checks.push({ id: "badges", status: "ok", label: "Badges",
    detail: badges.length ? badges.map((b) => b.key).join(", ") : "none yet",
    fixes: [] });

  // 6. Completeness surface, with the exact missing fields named
  checks.push({
    id: "completeness",
    status: t.completeness >= 80 ? "ok" : t.completeness >= 50 ? "warn" : "warn",
    label: "Completeness",
    detail: `${t.completeness}% (${checklist.length - missing.length}/${checklist.length} fields)`,
    fixes: missing.map((c) => `add ${c.field} — ${c.label}`),
  });

  const failed = checks.filter((c) => c.status === "fail");
  const warned = checks.filter((c) => c.status === "warn");
  const healthy = failed.length === 0;

  if (json) {
    process.stdout.write(JSON.stringify({
      file, ok: healthy, id: persona && persona.id, tier: t.tier,
      completeness: t.completeness, badges: badges.map((b) => b.key),
      faceResolved: face.resolved, inRegistry, signed: ver.signed, signatureValid: ver.ok,
      checks,
    }, null, 2) + "\n");
    return healthy ? 0 : 1;
  }

  const sym = (s) => (s === "ok" ? green("✓") : s === "warn" ? yellow("⚠") : red("✗"));
  const head = healthy
    ? (warned.length ? `${yellow("⚠ READY (with notes)")}` : `${green("✓ HEALTHY")}`)
    : `${red("✗ NOT READY")}`;
  process.stdout.write(`${head} ${dim(path.basename(file))} ${dim(`· ${persona && persona.id || "?"}`)}\n`);
  for (const c of checks) {
    process.stdout.write(`  ${sym(c.status)} ${bold(c.label)} ${dim("— " + c.detail)}\n`);
    for (const fix of c.fixes) {
      process.stdout.write(`        ${dim("↳ " + fix)}\n`);
    }
  }
  const tally = `${green(checks.filter((c) => c.status === "ok").length + " ok")}` +
    (warned.length ? ` · ${yellow(warned.length + " warn")}` : "") +
    (failed.length ? ` · ${red(failed.length + " fail")}` : "");
  process.stdout.write(`  ${dim("—")} ${tally}\n`);
  return healthy ? 0 : 1;
}

// openagent org <init|attest|verify> ...
//   init   — build the /.well-known/openagent.json an org publishes (org key in)
//   attest — mint an org.verification block vouching a persona's did:key (org key)
//   verify — resolve the org's did:web and check a persona's org.verification
async function cmdOrg(args) {
  const org = require("../lib/org");
  const sub = args[0];
  const rest = args.slice(1);

  if (sub === "init") {
    let url = null, name = null, keyPath = null, keyId = null, out = null;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--url") url = rest[++i];
      else if (a === "--name") name = rest[++i];
      else if (a === "--key") keyPath = rest[++i];
      else if (a === "--key-id") keyId = rest[++i];
      else if (a === "-o" || a === "--out") out = rest[++i];
    }
    if (!url || !name || !keyPath) {
      process.stderr.write(red("org init: --url <https://org.com> --name <Org> --key <orgpriv.key> required\n"));
      return 2;
    }
    let doc;
    try {
      const privateKey = fs.readFileSync(keyPath, "utf8");
      doc = org.buildOrgDoc({ url, name, privateKey, keyId });
    } catch (e) {
      process.stderr.write(red(`org init: ${e.message}\n`));
      return 2;
    }
    const json = JSON.stringify(doc, null, 2) + "\n";
    if (out) {
      fs.writeFileSync(out, json);
      process.stdout.write(
        `${green("✓ ORG DOC")} ${out} ${dim(`· ${doc.did}`)}\n` +
          `          ${dim("publish at")} ${org.wellKnownUrlForDid(doc.did)}\n`
      );
    } else {
      process.stdout.write(json);
      process.stdout.write(`${dim("→ publish this at " + org.wellKnownUrlForDid(doc.did))}\n`);
    }
    return 0;
  }

  if (sub === "attest") {
    let keyPath = null, url = null, did = null, keyId = null, agent = null, out = null, issuedAt = null;
    const positional = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--key") keyPath = rest[++i];
      else if (a === "--url") url = rest[++i];
      else if (a === "--did") did = rest[++i];
      else if (a === "--key-id") keyId = rest[++i];
      else if (a === "--agent") agent = rest[++i];
      else if (a === "--issued-at") issuedAt = rest[++i];
      else if (a === "-o" || a === "--out") out = rest[++i];
      else positional.push(a);
    }
    const file = positional[0];
    if (!file || !keyPath || (!url && !did)) {
      process.stderr.write(red("org attest <persona> --key <orgpriv.key> (--url <org> | --did <did:web>) [--key-id id] [-o out]\n"));
      return 2;
    }
    let persona, orgPrivateKey;
    try {
      persona = loadPersona(file);
      orgPrivateKey = fs.readFileSync(keyPath, "utf8");
    } catch (e) {
      process.stderr.write(red(`org attest: ${e.message}\n`));
      return 2;
    }
    const agentDid = agent || org.agentDidFromPersona(persona);
    if (!agentDid) {
      process.stderr.write(
        red("org attest: persona has no identity to vouch for.\n") +
          dim("  Give it one first (keygen + sign), or pass --agent <did:key>.\n")
      );
      return 2;
    }
    let block;
    try {
      block = org.signOrgAttestation(orgPrivateKey, { agentDid, orgUrl: url, orgDid: did, keyId, issuedAt });
    } catch (e) {
      process.stderr.write(red(`org attest: ${e.message}\n`));
      return 2;
    }
    const alreadySigned = !!(persona.provenance && persona.provenance.signature);
    persona.org = persona.org && typeof persona.org === "object" ? persona.org : { name: block.did };
    persona.org.verification = block;
    const recheck = require("../lib/validate").validateDoc(persona);
    if (!recheck.ok) {
      process.stdout.write(`${red("✗")} attested document no longer validates:\n`);
      for (const err of recheck.errors) process.stdout.write(`        ${red("•")} ${err}\n`);
      return 1;
    }
    const target = out || file;
    fs.writeFileSync(target, YAML.stringify(persona));
    process.stdout.write(`${green("✓ ATTESTED")} ${target} ${dim(`· ${block.did} vouches ${agentDid}`)}\n`);
    if (alreadySigned) {
      process.stdout.write(
        `  ${yellow("⚠")} ${dim("this persona was already signed — its provenance signature is now stale.")}\n` +
          `     ${dim("Re-sign as the agent: openagent sign " + target + " --key <agent.key>")}\n`
      );
    }
    return 0;
  }

  if (sub === "verify") {
    const json = rest.includes("--json");
    const file = rest.find((a) => !a.startsWith("-"));
    if (!file) {
      process.stderr.write(red("org verify: no persona file given\n"));
      return 2;
    }
    let persona;
    try {
      persona = loadPersona(file);
    } catch (e) {
      if (json) process.stdout.write(JSON.stringify({ verified: false, error: e.message }, null, 2) + "\n");
      else process.stderr.write(red(`org verify: ${e.message}\n`));
      return 2;
    }
    const r = await org.verifyOrgAffiliation(persona, { resolve: org.fetchResolver });
    if (json) {
      process.stdout.write(JSON.stringify({ file, ...r }, null, 2) + "\n");
      return r.verified ? 0 : 1;
    }
    if (!r.verified) {
      const declared = persona.org && persona.org.name ? ` ${dim("(org.name: " + persona.org.name + ", self-declared only)")}` : "";
      process.stdout.write(`${dim("○ UNVERIFIED ORG")} ${file}${declared} ${dim("— " + r.reason)}\n`);
      return 1;
    }
    process.stdout.write(`${green("✓ VERIFIED ORG")} ${file} ${dim(`· ${r.org.name} (${r.org.did})`)}\n`);
    process.stdout.write(`  ${dim("vouches")} ${r.agent}${r.keyId ? dim(` · via key ${r.keyId}`) : ""}\n`);
    if (r.nameMatches === false) {
      process.stdout.write(`  ${yellow("⚠")} ${dim(`persona org.name "${persona.org.name}" ≠ verified "${r.org.name}" — display the verified name`)}\n`);
    }
    return 0;
  }

  process.stderr.write(
    red("org: unknown subcommand" + (sub ? ` '${sub}'` : "")) +
      "\n" +
      dim("  openagent org init   --url <org> --name <Org> --key <orgpriv.key> [--key-id id] [-o openagent.json]\n") +
      dim("  openagent org attest <persona> --key <orgpriv.key> (--url <org> | --did <did:web>) [--key-id id] [-o out]\n") +
      dim("  openagent org verify <persona> [--json]\n")
  );
  return 2;
}

async function cmdInit(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-o" || a === "--out") opts.out = args[++i];
    else if (a === "--name") opts.name = args[++i];
    else if (a === "--role") opts.role = args[++i];
    else if (a === "--id") opts.id = args[++i];
    else if (a === "--org") opts.org = args[++i];
    else if (a === "--force") opts.force = true;
    else {
      process.stderr.write(red(`init: unknown argument: ${a}\n\n`) + USAGE);
      return 2;
    }
  }
  const r = await runInit(opts);
  if (r.code !== 0) return r.code;

  // Round-trip the scaffold through the real validator so init never emits a
  // file that `validate` would reject — and show the same tier/next-rung quest
  // line, so the user immediately sees how to climb the ladder.
  process.stdout.write(`\n${green("✓ wrote")} ${bold(r.file)}\n\n`);
  const code = cmdValidate([r.file]);
  process.stdout.write(
    `\n${dim("next:")} openagent card ${r.file}   ${dim("→ mint your holo card")}\n`
  );
  return code === 0 ? 0 : code;
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
  let engine = null;
  const pos = [], flags = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--engine") engine = args[++i];
    else if (args[i].startsWith("-")) flags.push(args[i]);
    else pos.push(args[i]);
  }
  const json = flags.includes("--json");
  const [file, scene] = pos;
  if (!file || !scene) {
    process.stderr.write(red('flow: usage: openagent flow <persona-file> "<scene>" [--engine <name>] [--json]\n\n') + USAGE);
    return 2;
  }
  const v = validateFile(file);
  if (!v.ok) {
    process.stdout.write(`${red("✗")} ${file} is not a valid persona:\n`);
    for (const err of v.errors) process.stdout.write(`        ${red("•")} ${err}\n`);
    return 1;
  }
  const r = flow(file, scene, { engine });
  if (r.error) { process.stderr.write(red(`flow: ${r.error}\n`)); return 1; }
  if (json) { process.stdout.write(JSON.stringify(r, null, 2) + "\n"); return 0; }
  const engineTag = r.engine ? r.engine : "engine-neutral";
  process.stdout.write(`${green("✓ FLOW")}  ${r.name}${r.role ? dim(" — " + r.role) : ""} ${dim("· paste into " + (r.engine || "Flow/Veo/Runway/Kling/…"))}\n\n`);
  if (r.refs.length) {
    process.stdout.write(`${bold("character reference")}${r.provider ? dim(" (" + r.provider + ")") : ""}\n`);
    for (const ref of r.refs) process.stdout.write(`  ${ref}\n`);
    process.stdout.write("\n");
  }
  process.stdout.write(`${bold("prompt")}\n${r.prompt}\n`);
  process.stdout.write(`\n${dim(`engine: ${engineTag}   model: ${r.model || "-"}   seed: ${r.seed != null ? r.seed : "-"}`)}\n`);
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

  if (cmd === "init") return cmdInit(rest);
  if (cmd === "validate") return cmdValidate(rest);
  if (cmd === "card") return cmdCard(rest);
  if (cmd === "tier") return cmdTier(rest);
  if (cmd === "registry") return cmdRegistry(rest);
  if (cmd === "speak") return cmdSpeak(rest);
  if (cmd === "keygen") return cmdKeygen(rest);
  if (cmd === "address") return cmdAddress(rest);
  if (cmd === "id") return cmdId(rest);
  if (cmd === "sign") return cmdSign(rest);
  if (cmd === "verify") return cmdVerify(rest);
  if (cmd === "doctor") return cmdDoctor(rest);
  if (cmd === "org") return cmdOrg(rest);
  if (cmd === "flow") return cmdFlow(rest);
  if (cmd === "handshake") return cmdHandshake(rest);
  if (cmd === "receipt") return cmdReceipt(rest);

  process.stderr.write(red(`unknown command: ${cmd}\n\n`) + USAGE);
  return 2;
}

// openagent handshake <present|challenge|respond|verify> — A2A liveness proof
// (DIVE-730). Scriptable JSON in/out; identity loaded from the keystore so the
// caller never handles a key. Pairs with the signed registry for the official
// identity; this proves the peer holds the private half RIGHT NOW.
function cmdHandshake(args) {
  const hs = require("../lib/handshake");
  const sub = args[0];
  const rest = args.slice(1);
  const flag = (n) => {
    const i = rest.indexOf(n);
    return i >= 0 ? rest[i + 1] : null;
  };
  const emit = (o) => process.stdout.write(JSON.stringify(o, null, 2) + "\n");

  if (sub === "present") {
    const kp = loadOrCreateAgentKey();
    emit(hs.present({ privateKey: kp.privateKey, handle: flag("--handle"), cardUrl: flag("--url") }));
    return 0;
  }
  if (sub === "challenge") {
    emit({ nonce: hs.challenge() });
    return 0;
  }
  if (sub === "respond") {
    const nonce = rest.find((a) => !a.startsWith("-")) || flag("--nonce");
    if (!nonce) {
      process.stderr.write(red("handshake respond: a nonce is required\n"));
      return 2;
    }
    const kp = loadOrCreateAgentKey();
    emit({ did: kp.did, signature: hs.respond(nonce, kp.privateKey) });
    return 0;
  }
  if (sub === "verify") {
    const presF = flag("--presentation");
    if (!presF) {
      process.stderr.write(red("handshake verify: --presentation <file> required\n"));
      return 2;
    }
    let presentation;
    try {
      presentation = JSON.parse(fs.readFileSync(presF, "utf8"));
    } catch (e) {
      process.stderr.write(red(`handshake verify: ${e.message}\n`));
      return 2;
    }
    const r = hs.verifyResponse({ presentation, nonce: flag("--nonce"), signature: flag("--signature") });
    emit(r);
    return r.ok ? 0 : 1;
  }
  process.stderr.write(red(`handshake: unknown subcommand${sub ? ` '${sub}'` : ""} (present|challenge|respond|verify)\n`));
  return 2;
}

// openagent receipt <sign|cosign|verify|history> — co-signed work receipts
// (DIVE-730). The verifiable edge between two agents: two ed25519 signatures
// over one canonical body. No chain, no token — both parties just attest the
// work happened. Identity loaded from the keystore.
function cmdReceipt(args) {
  const rc = require("../lib/receipts");
  const sub = args[0];
  const rest = args.slice(1);
  const flag = (n) => {
    const i = rest.indexOf(n);
    return i >= 0 ? rest[i + 1] : null;
  };
  const emit = (o) => process.stdout.write(JSON.stringify(o, null, 2) + "\n");
  const firstFile = () => rest.find((a) => !a.startsWith("-"));

  if (sub === "sign") {
    const task = flag("--task");
    const result = flag("--result");
    const to = flag("--to");
    if (!task || !result || !to) {
      process.stderr.write(red("receipt sign: --task, --result and --to <did> are required\n"));
      return 2;
    }
    const kp = loadOrCreateAgentKey();
    const receipt = rc.buildReceipt({
      taskHash: rc.hash(task),
      resultHash: rc.hash(result),
      fromDid: flag("--from") || kp.did,
      toDid: to,
      at: flag("--at") || new Date().toISOString(),
    });
    emit({ receipt, sigs: [rc.sign(receipt, kp.privateKey)] });
    return 0;
  }
  if (sub === "cosign") {
    const f = firstFile();
    if (!f) {
      process.stderr.write(red("receipt cosign: a <partial-receipt-file> is required\n"));
      return 2;
    }
    let co;
    try {
      co = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch (e) {
      process.stderr.write(red(`receipt cosign: ${e.message}\n`));
      return 2;
    }
    const kp = loadOrCreateAgentKey();
    co.sigs = [...(co.sigs || []), rc.sign(co.receipt, kp.privateKey)];
    emit(co);
    return 0;
  }
  if (sub === "verify") {
    const f = firstFile();
    if (!f) {
      process.stderr.write(red("receipt verify: a <receipt-file> is required\n"));
      return 2;
    }
    let co;
    try {
      co = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch (e) {
      process.stderr.write(red(`receipt verify: ${e.message}\n`));
      return 2;
    }
    const r = rc.verify(co, { requireBoth: !rest.includes("--one-sided-ok") });
    emit(r);
    return r.ok ? 0 : 1;
  }
  if (sub === "history") {
    const f = firstFile();
    if (!f) {
      process.stderr.write(red("receipt history: a <history.jsonl> file is required\n"));
      return 2;
    }
    let lines;
    try {
      lines = fs.readFileSync(f, "utf8").split("\n");
    } catch (e) {
      process.stderr.write(red(`receipt history: ${e.message}\n`));
      return 2;
    }
    const self = flag("--self") || (loadAgentKey() || {}).did || null;
    emit(rc.verifyHistory(lines, self));
    return 0;
  }
  process.stderr.write(red(`receipt: unknown subcommand${sub ? ` '${sub}'` : ""} (sign|cosign|verify|history)\n`));
  return 2;
}

main(process.argv).then((code) => process.exit(code)).catch((e) => {
  process.stderr.write(red(`error: ${e.stack || e.message}\n`));
  process.exit(2);
});
