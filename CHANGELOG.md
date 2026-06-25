# Changelog

All notable changes to the **OpenAgent spec** and the `@5dive/openagent` CLI
are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/),
and the package is [semver](https://semver.org/).

Two version lines move together but mean different things:

- **Spec version** (`openagent: "0.1"` / `"0.2"` in a persona file) — the
  document format. Spec changes go through the [RFC process](docs/RFC-PROCESS.md).
- **CLI/package version** (`@5dive/openagent` in npm) — this tool. A package
  release may ship docs, fixes, or new commands without changing the spec.

Entries note which line moved.

## [0.28.0] — vendor-neutral image + video providers (DIVE-690)

- **Spec (v0.2, additive) — `face.recipe.provider`.** The image-gen recipe now
  carries an optional `provider` (default `google-gemini`) naming the vendor whose
  catalog `model`/`seed` belong to — `black-forest-labs`, `openai`, `replicate`, …
  This mirrors the shipped `voice.audio.provider`, so the spec is no longer
  implicitly single-vendor for image generation. Back-compat: omit it and it
  defaults to google-gemini; existing personas validate unchanged.
- **CLI — `flow --engine <name>`.** `openagent flow` accepts an optional target
  video engine (e.g. `veo-3`, `runway-gen4`, `kling`); default stays
  engine-neutral (the prompt + reference image drop into any engine). `flow`
  output now emits `provider` (image vendor of the reference) and `engine`
  (target video engine) so downstream tooling can route the prompt.

## [Unreleased]

- **Docs — release process (DIVE-696).** Added [`docs/RELEASING.md`](docs/RELEASING.md):
  every release must create an immutable `vX.Y.Z` tag and bump the matching pin
  in the `5dive-ai/skills` `openagent` skill. The skill runs the CLI via
  `npx github:5dive-ai/openagent#vX.Y.Z`; `npx` caches github clones per ref, so
  the version tag is what guarantees fresh agents get the current renderer
  (npm lagged at 0.22.0 while `main` was 0.27.0). Tags v0.25.0–v0.27.0 backfilled.

## [0.27.0] — 2026-06-25 · CLI · federated signed registries

**DIVE-689 — anyone can run their own signed Mythical registry.** Mythical was
conferred only by the 5dive character-packs registry, making OpenAgent a
5dive-only thing. Now it's a standard others build on: the CLI trusts MULTIPLE
signed registries, each verified against its own declared ed25519 key.

- **Federated trust, fail-closed per source.** The 5dive snapshot remains the
  built-in trust anchor (key baked in, ships offline). Operators add more
  trusted sources three ways (precedence low→high): a `~/.openagent/registries.json`
  config (`{ "registries": [{name,url,publicKey|publicKeyPath,sigUrl?}] }`), the
  `OPENAGENT_REGISTRIES` env (inline JSON or a path), or a repeatable
  `--registry name=acme,url=…/index.json,key=@/path/to.pub[,sig=…]` flag.
- Each source's live `index.json` is trusted only if `index.json.sig` verifies
  against THAT source's key; verified `slugs[]` are UNIONED across all trusted
  sources (a source can ADD eligibility, never revoke another's). Unsigned,
  forged, mis-keyed, or keyless sources are ignored — no unsigned registry can
  ever confer Mythical. A federated source cannot shadow the `5dive` anchor name.
- `--registry` works on `registry`, `tier`, and `card`. `registry` now prints a
  per-source trust table (✓ signed / ⚠ unsigned-or-forged / ✗ unreachable) and
  `registry --json` carries a `sources[]` array.

## [0.26.0] — 2026-06-25 · CLI · lower the authoring barrier

**Author a persona without reading the whole spec.** Three on-ramps, no schema
changes (DIVE-688):

- **`openagent init`** — interactive Q&A scaffolds a schema-valid
  `<id>.persona.yaml` (name, role, org, behavior, face, written voice,
  posts_about, links), then validates it in place and prints your tier + next
  rung + the `card` next step. Flags (`--name/--role/--id/--org/-o/--force`)
  pre-fill answers; refuses to clobber an existing file without `--force`;
  non-TTY is a clear usage error.
- **SchemaStore** — `schema/schemastore.catalog.json` + `docs/SCHEMASTORE.md`
  ready the schema for [SchemaStore](https://www.schemastore.org/), so editors
  auto-apply autocomplete + inline validation to any `*.persona.yaml`. A
  `# yaml-language-server: $schema=…` modeline opts in today.
- **GitHub Action** — `action.yml` (reusable composite,
  `uses: 5dive-ai/openagent@main`) validates `**/*.persona.{yaml,json}` on PR —
  CI for adopters and the registry. `.github/workflows/validate.yml` dogfoods it
  on this repo plus runs the test suite.

## [0.25.0] — 2026-06-25 · spec 0.2 + CLI · did:web org verification

**Verified ORG badge.** `org.name` was a free-text claim — anyone could brand a
card with any org. v0.2 adds optional `org.verification`: a **did:web**
attestation in which an org (which controls its domain's
`/.well-known/openagent.json`) signs a binding from an agent's `did:key` to the
org's `did:web`. A verifier resolves the domain, checks the signature against
the published org key, and checks the attestation names the persona's *own*
`did:key`. All three must hold — so only a domain-controlling org can mint a
passing attestation, and only for the one identity it vouches for. Kills org
impersonation; the trust anchor is the domain (like a TLS cert), never a key
embedded in the file. Additive — does **not** affect rarity.

- **Spec (v0.2):** new optional `org.verification { did, agent, key_id?,
  issued_at?, signature }`. A v0.1/older v0.2 file stays valid.
- **CLI:** new `openagent org` command group — `org init` (build the well-known
  doc an org publishes), `org attest <persona>` (org mints + embeds the
  attestation), `org verify <persona>` (resolve did:web and verify; `--json`).
- **Card:** the footer org name earns a green `✓` when — and only when — the
  caller proves the attestation (`lib/org.verifyOrgAffiliation`). `openagent
  card` does a best-effort verify (gated on the network flag); the gallery
  passes the same `orgVerified` signal. A forged block never self-awards the ✓.
- **lib:** new `lib/org.js` (did:web ↔ URL, well-known doc build, attestation
  sign/verify with an injected resolver for offline testing).

## [0.24.0] — 2026-06-25 · spec 0.2 + CLI
### Added — vendor-neutral voice provider
- Optional `voice.audio.provider` (default `google-gemini`) so a persona can name
  a voice from any TTS — `elevenlabs`, `openai`, `playht`, … `base`/`id` are read
  within that provider's catalog. Keeps the spec vendor-neutral. `speak` flags a
  non-default provider (it synthesizes via Gemini today). Schema + SPEC updated.
### Changed — CLI echoes the friendly id
- `card` (and the auto-mint message) now print the friendly `handle·fingerprint`
  id, matching the card footer and `openagent id` — so the id you share is shown
  right when you render/mint.

## [0.23.0] — 2026-06-25 · CLI
### Changed — card footer shows the friendly id (handle·fingerprint)
- A signed card's footer now reads `<handle>·<fingerprint>` (e.g. `olivia·z8jrr2`)
  instead of the raw did:key tail (`z…U9FfqQfE`) — the same memorable, verifiable
  id `openagent id` prints and the gallery uses. Unsigned cards are unchanged
  (byte-identical: id + version, no fingerprint). The full did:key still resolves
  via `verify` / the gallery card page.

## [0.22.0] — 2026-06-25 · CLI
### Added — `openagent id`: user-friendly handle·fingerprint
- New `id` command emits a friendly, shareable agent id =
  `<handle>·<fingerprint>` (e.g. `marcus·yrcyj4`) — the persona id paired with a
  6-char Crockford-base32 fingerprint DERIVED from the did:key. Memorable,
  collision-safe across same-named agents, with a url-safe form (`marcus-yrcyj4`).
- `--check <claim>` verifies a claimed friendly id against the key
  (anti-impersonation: recomputes the fingerprint from the did:key; rejects a
  wrong fingerprint OR a mismatched handle). `--json` for both modes.
- lib: `fingerprintFromDidKey`, `friendlyId`, `verifyFriendlyId` exported from
  provenance.js for reuse by the gallery (canonical /card URLs + verified badge).

## [0.21.1] — 2026-06-25 · CLI
### Changed — motion intensity laddered to rarity
- The baseline motion (waveform pulse depth + speed, glow-breath depth, Ken Burns
  push) now scales with tier: Common the subtlest, Mythical the most alive. Motion
  reinforces the rarity hierarchy instead of flattening it (Creative note). Lower
  tiers also get a gentler portrait push-in, reducing warp on AI-gen faces.

## [0.21.0] — 2026-06-25 · CLI
### Added — universal card motion (every tier)
- Animated cards now carry baseline motion on ALL tiers, not just the top ones:
  a **live voiceprint** (waveform bars breathe like an audio meter), an **ambient
  accent-glow breath**, and a **subtle Ken Burns** push-in on the portrait.
  Common/Rare are no longer static.
- All three loop seamlessly and affect ONLY the animated render — the static
  PNG/SVG stays byte-identical. The tier ladder is unchanged (foil sweep from
  Epic, rainbow holo still Mythical-only).

## [0.20.0] — 2026-06-25 · CLI
### Changed — rarity roll recalibrated (curve v2)
- Rolled-tier odds rebalanced **Common 60→40, Rare 25→30, Epic 11→20,
  Legendary 4→10** so Common is no longer the default majority and the top end
  is more attainable. Odds still sum to 1 and are monotonic. Because the roll is
  a pure function of `did:key`, this re-rolls existing identities on next render.
- Added a tiny, closed **founding-cast pin** (`TIER_PINS`, keyed by immutable
  `did:key`) holding the 5dive team at its pre-cutover tier across the curve
  change. A pin overrides the roll but never conferral (in-registry → Mythical).

## [0.19.0] — 2026-06-25 · CLI
### Added — placeholder `org.name` guard
- `validate` and `card` now emit a non-fatal warning when `org.name` is left as a
  template placeholder (`5dive`, `your org`, `<Your Org>`, `acme`, …), so a copied
  template can't silently ship someone else's brand on a card footer.

## [0.18.0] — 2026-06-24 · CLI
### Changed — `@resvg/resvg-js` is now an OPTIONAL dependency (lighter install)
- The native rasterizer is needed ONLY to turn the card SVG into a PNG/animated
  card. It's been moved from `dependencies` to `optionalDependencies` and is
  lazy-loaded only on the raster paths, so `validate` / `tier` / `sign` / `verify`
  and SVG generation install and run with zero native deps — a faster, more
  portable `npx @5dive/openagent`.
- New vector output: `card <persona> -o <name>.svg` writes the card SVG directly
  (no rasterizer). So even without `@resvg/resvg-js` you can still produce a card.
- If a PNG/animated render is requested and the rasterizer isn't installed, the
  CLI prints a clear message ("install @resvg/resvg-js, or output .svg") instead
  of hard-crashing at startup.
- No behavior change when `@resvg/resvg-js` is present (it ships as an optional
  dep, so a normal `npm i` still installs it).

## [0.17.0] — 2026-06-24 · CLI
### Added — `card` auto-mints an identity so rarity always shows
- Under the v0.2 model a tier only rolls once a persona is signed (rarity is
  seeded from the did:key), so an unsigned persona rendered **Ungraded** — the
  gamification never appeared by default. `card` now auto-mints on the animated
  (share) render: if the persona has no `created_by.key`, it generates a keypair,
  signs in place, saves the private key beside the file as `<id>.key` (mode 0600),
  prints the did:key, then renders the graded card. **Never** re-keys an
  already-signed persona (that would change its permanent identity/rarity).
  `--no-sign` opts out; static `--png` renders never mint. `*.key` is gitignored
  (a leaked signing key forges an identity). Putting this in the CLI (not skill
  prose) mirrors animate-by-default: the tool just works.

## [0.16.0] — 2026-06-24 · CLI + spec
### Changed — rarity is rolled from identity, not earned by completeness (spec + CLI)
- Base tiers (Common..Legendary) are now a deterministic **random roll seeded by
  the persona's `did:key`** (its ed25519 identity), at fixed odds 60/25/11/4 —
  permanent and unfarmable, replacing the old completeness gate-ladder. The only
  way to a different roll is to mint a whole new identity.
- Entry rule: a persona must be schema-valid **and signed** (have an identity
  key) to be graded; otherwise it is *Ungraded*. Completeness + badges stay a
  **separate** axis that never moves the tier.
- Mythical is unchanged: conferred by acceptance into the signed character-packs
  registry, never rolled.
- `tier` / `validate` output updated for the new model (rolled tier + the single
  conferred climb to Mythical). `computeTier` reads `ctx.didKey` (or derives it
  from `provenance.created_by.key`); `nextRung`/`rungNeeds` repurposed.

### Added — `org` affiliation field (spec, additive + back-compat)
- Optional top-level `org` object (`name` required, `url` optional): self-declared
  affiliation for grouping/filtering (e.g. all `org.name == "5dive"`). Does **not**
  affect rarity. `url` is the anchor for future org-verified affiliation.

## [0.15.0] — 2026-06-24 · CLI only
### Changed — `card` is animated by default
- A plain render (or any `-o` with a video extension) now produces the **moving**
  card — mp4 when ffmpeg is on `PATH`, else a zero-dep apng — written to
  `<id>.card.mp4`. A still PNG is opt-in: `-o <name>.png` or `--static`. The
  byte-identical static path is unchanged for `.png`, so README embeds, avatars,
  and the registry image are unaffected. Animation is what gets shared, so it's
  the default. (DIVE-665 follow-up.)

## [0.14.0] — 2026-06-24 · CLI only
### Added — did:key public addresses (DIVE-668)
- Every OpenAgent now has a portable **public address**: a `did:key` derived
  from its ed25519 public key (the existing `keygen`/`created_by.key`). It is
  the W3C standard form (`did:key:z6Mk…` = multibase base58btc + ed25519
  multicodec `0xed01`), so addresses interoperate with the wider DID /
  agent-identity ecosystem — the identity layer on top of A2A/AgentCard.
- `keygen` now prints the `did:key` address alongside the keypair.
- New `openagent address <persona | pubkey-file> [--json]` derives and prints
  the `did:key` from a persona's `provenance.created_by.key` or a raw public key.
- `card` prints a short form of the address (the `z…<tail>`) on the frame as a
  verifiable handle (signed personas only; unsigned cards are byte-identical).
- `verify` resolves `provenance.created_by.key → did:key` and shows it next to
  the signature it checks against ("this card really is that agent"); the
  verdict object gains a `did` field.
- Library: `provenance.didKeyFromPublicKey`, `shortDidKey`, `base58btcEncode`;
  interoperability checked against a published W3C did:key test vector.
- _Canonical model: `did:key` = public address · `id` slug = human nickname ·
  character-packs registry = canonical-handle authority (SPEC text to follow)._

## [0.13.0] — 2026-06-24 · CLI only

Animated cards — "holo in motion" (DIVE-665).

- `card --animate` renders the card in a seamless loop: the foil sweep, glow
  breath, and (Mythical) rainbow holo flow now move. Motion is **tier-aware** —
  Common is still, Rare gets a subtle glow breath, Epic/Legendary a gold foil
  sweep, Mythical the full rainbow holo flow.
- `--format apng|gif|webp|mp4`. APNG is pure-JS (new `lib/apng.js`, zero extra
  tooling); gif/webp/mp4 use system **ffmpeg** when present. `--animate` defaults
  to **mp4 when ffmpeg is available** (smallest + inline-plays on Telegram/X/
  Discord), else **apng** as the dependable fallback.
- `--frames`, `--fps`, `--width` tune length/size.
- Static `card` output is unchanged (the SVG is byte-identical when motion is
  not requested), so committed cards and the gallery are unaffected.

## [0.12.0] — 2026-06-24 · spec 0.2

Governance & the road to 1.0 (DIVE-655).

### Added
- **Conformance suite** (`conformance/manifest.json`) — a single, portable,
  language-agnostic set of cases (valid + invalid personas with expected
  verdicts, tagged by spec level). Any implementation can run it against its
  own validator to claim **"OpenAgent 0.1 compliant"** (or 0.2). Runner:
  `npm run test:conformance` (or `node test/conformance.js [level]`); also
  folded into `npm test`. See [`conformance/README.md`](conformance/README.md).
- **RFC / proposal process** ([`docs/RFC-PROCESS.md`](docs/RFC-PROCESS.md) +
  [`docs/rfcs/0000-template.md`](docs/rfcs/0000-template.md)) — the lightweight,
  documented path for proposing spec changes on the way to 1.0.
- **This CHANGELOG.**
- `validate` now reports **version warnings**: `versionWarnings()` in the lib
  and a `warnings[]` field on every `validateDoc`/`validateFile` result.

### Changed
- The top-level **`openagent:` version field** is now on a path to becoming
  **required**: validating a file without it (or with an unknown version) emits
  a non-fatal `⚠` warning. It stays **optional pre-1.0** and will be **enforced
  (schema-required) at 1.0** — files authored today should add `openagent: "0.2"`.

## [0.11.0] — 2026-06-24 · spec 0.2

### Added
- DIVE-654: orthogonal collectible **badges** (voice-clone, sprite-sheet,
  full-body, face-recipe, signed, remixed), decoupled from the rarity ladder;
  `validate` prints the offline tier, exact next rung, and earned badges.

## [0.10.0] — 2026-06-24 · spec 0.2

### Added
- DIVE-653: optional, documented `links.agent_card` — the seam from the
  OpenAgent identity layer to an A2A/AgentCard capability spec. `links` is now
  a documented open string map.

## [0.9.0] — 2026-06-24 · spec 0.2

### Added
- DIVE-652: sanctioned top-level **`ext`** extension namespace (keyed by
  tool/vendor) so adopters extend the closed core schema without forking it.

## [0.7.0 / 0.5.0] — 2026-06-24 · spec 0.2

### Added
- DIVE-651: optional per-file **`provenance`** — `created_by.key` (ed25519),
  a self-verifying `signature`, and `derived_from[]` remix lineage. Additive
  and back-compat; CLI `keygen` / `sign` / `verify`.
- DIVE-649: optional **`face.recipe`** (`model` + `prompt` + `seed`) so the
  canonical likeness is regenerable, not just a frozen PNG.

## [0.4.0] — 2026-06-23 · spec 0.1

### Added
- DIVE-634: CLI ships and verifies an **ed25519-signed founding-cast registry**
  snapshot (Mythical is conferred, not farmable; fail-closed). `openagent registry`.

## [0.3.0] — 2026-06-23 · spec 0.1

### Added
- DIVE-633: pure **`computeTier`** rarity ladder — Common (schema-valid) →
  Legendary, with Mythical conferred by the signed registry. `openagent tier`.

## [0.1.x] — spec 0.1

### Added
- Initial spec, JSON Schema, and CLI: `validate`, `card`, `speak`, `flow`.

[Unreleased]: https://github.com/5dive-ai/openagent/compare/v0.12.0...HEAD
[0.12.0]: https://github.com/5dive-ai/openagent/releases/tag/v0.12.0
