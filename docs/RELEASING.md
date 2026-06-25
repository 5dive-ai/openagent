# Releasing `@5dive/openagent`

A release is **not done** until the npm version is published *and* the skill pin
points at it. Skipping either re-introduces DIVE-696/701: the `openagent` skill
runs the CLI via `npx`, and `npx` caches per version — so a stale npm publish (or
an unpinned github ref, which caches per-ref and can serve a partial clone missing
bundled fonts) silently serves an old renderer to fresh agents. Publishing the new
npm version and pinning the skill to it is what guarantees freshness every release.
(Since DIVE-699, npm is the authoritative channel and publishing is automated via
a stored token — see step 5.)

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
4. **Publish to npm.** Run the helper — it reads the stored automation token,
   publishes `package.json`'s version, and never writes the token to disk
   persistently:
   ```bash
   ./scripts/npm-publish.sh --dry-run   # auth + pack check
   ./scripts/npm-publish.sh             # publish @5dive/openagent@X.Y.Z
   npm view @5dive/openagent version    # confirm X.Y.Z is live
   ```
5. **Bump the skill pin.** In [`5dive-ai/skills`](https://github.com/5dive-ai/skills),
   edit `openagent/SKILL.md` and bump every `npx @5dive/openagent@A.B.C` to
   `@X.Y.Z` (a single find/replace — the count should match before/after), then
   commit + push. This delivers the new renderer to newly created agents.
   ```bash
   sed -i 's|@5dive/openagent@[0-9.]*|@5dive/openagent@X.Y.Z|g' openagent/SKILL.md
   grep -c '@5dive/openagent@X.Y.Z' openagent/SKILL.md   # sanity-check the count
   ```
6. **Tag the release commit** for provenance — immutable, one tag per version:
   ```bash
   git tag vX.Y.Z <release-commit> && git push origin vX.Y.Z
   ```

## Why npm, not the github pin

Earlier the skill pinned the **github ref** because npm publishing was gated on a
human-held token and drifted behind `main` (it sat at `0.22.0` while `main` was
`0.27.0` — DIVE-696). DIVE-699 restored npm publishing with a stored automation
token (`/etc/5dive/connectors/npm.env`, used only by `scripts/npm-publish.sh`), so
npm is now authoritative: its tarball **bundles every font/asset** (a github
per-ref clone can serve a partial build → monospace font fallback, DIVE-701) and
`npx @5dive/openagent@X.Y.Z` is cache-correct per version. The github ref remains
documented in the skill as a fallback only.

## Existing agents

Steps 1–4 guarantee freshness for **newly created** agents (the create-path
clones the skill fresh). Agents that already have the skill installed keep their
copy until something re-pulls it — `install_default_skill_for_agent` skips an
already-present skill dir. Refreshing existing installs is a 5dive-cli concern
(`refresh-skills`), tracked separately.
