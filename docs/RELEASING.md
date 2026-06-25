# Releasing `@5dive/openagent`

A release is **not done** until the version tag exists *and* the skill pin
points at it. Skipping either re-introduces DIVE-696: the `openagent` skill runs
the CLI via `npx`, and `npx` caches GitHub clones **per ref** — so an unpinned
ref (or a stale npm publish) silently serves an old renderer to fresh agents.
A fresh version tag is what changes the cache key every release.

## Checklist (do these in order, every release)

1. **Bump the version.** `package.json` `version` → `X.Y.Z` (matches the new
   `## [X.Y.Z]` heading in [`CHANGELOG.md`](../CHANGELOG.md)).
2. **Land it on `main`.** Commit + push (tests + conformance green first:
   `npm test && npm run test:conformance`).
3. **Tag the release commit** — immutable, one tag per version:
   ```bash
   git tag vX.Y.Z <release-commit> && git push origin vX.Y.Z
   # or, on a checkout-less box, via the API:
   gh api -X POST repos/5dive-ai/openagent/git/refs \
     -f ref="refs/tags/vX.Y.Z" -f sha="<release-commit-sha>"
   ```
4. **Bump the skill pin.** In [`5dive-ai/skills`](https://github.com/5dive-ai/skills),
   edit `openagent/SKILL.md` and bump every `npx github:5dive-ai/openagent#vA.B.C`
   to `#vX.Y.Z` (a single find/replace — the count should match before/after),
   then commit + push. This is the step that actually delivers the new renderer
   to newly created agents.
   ```bash
   sed -i 's/openagent#v[0-9.]*/openagent#vX.Y.Z/g' openagent/SKILL.md
   grep -c 'openagent#vX.Y.Z' openagent/SKILL.md   # sanity-check the count
   ```
5. **(Optional, gated) Publish npm.** `npm publish` requires the npm publish
   token (a lodar-held secret) — do **not** self-serve it. The pinned github ref
   from step 4 is authoritative regardless; npm is a convenience mirror that may
   lag. If you publish, keep the npm `version` equal to the tag.

## Why the github pin, not npm

npm publishing is gated on a human-held token, so the npm package drifts behind
`main` (it sat at `0.22.0` while `main` was `0.27.0`). The skill therefore pins
the **github ref** as the source of truth: no secret needed, immutable per
release, and `npx`-cache-correct. See DIVE-696.

## Existing agents

Steps 1–4 guarantee freshness for **newly created** agents (the create-path
clones the skill fresh). Agents that already have the skill installed keep their
copy until something re-pulls it — `install_default_skill_for_agent` skips an
already-present skill dir. Refreshing existing installs is a 5dive-cli concern
(`refresh-skills`), tracked separately.
