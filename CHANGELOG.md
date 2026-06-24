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

## [Unreleased]

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
