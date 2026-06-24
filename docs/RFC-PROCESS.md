# OpenAgent RFC process

OpenAgent is a small spec that other tools build on, so changes to the
**document format** need a paper trail and a chance for adopters to weigh in.
This is that process — deliberately lightweight. Tooling-only changes (CLI
flags, rendering, bug fixes) do **not** need an RFC; just open a PR.

## When you need an RFC

Open an RFC for anything that changes what a *conforming persona file* looks
like or how it is judged:

- adding, removing, or renaming a top-level field or sub-field;
- changing whether a field is required, its type, or its allowed values;
- changing validation semantics or the rarity/badge rules;
- bumping the spec version (`0.x` → `0.y`, or the `1.0` cut).

If you're unsure, open an issue first and ask.

## The flow

1. **Copy the template.** `docs/rfcs/0000-template.md` → `docs/rfcs/NNNN-short-title.md`.
   Use the next free number (PR number is fine).
2. **Open a PR** with just the RFC file. The PR *is* the discussion thread.
3. **Discuss.** Maintainers and adopters comment. Iterate on the file.
4. **Decision.** A maintainer marks the RFC `accepted`, `rejected`, or
   `postponed` in its front matter and merges it (rejected/postponed RFCs are
   merged too — the record is the point).
5. **Implement.** An accepted RFC is implemented in a follow-up PR that:
   - updates `SPEC.md`, `schema/persona.schema.json`, and the CLI;
   - adds **conformance cases** (`conformance/manifest.json`) for the new behaviour;
   - adds a `CHANGELOG.md` entry;
   - keeps back-compat (see below) or, if it can't, says so loudly and waits for 1.0.

## Compatibility bar

Until **1.0**, every accepted change to the `0.x` line MUST be **additive and
backward-compatible**: a valid `0.1` file must stay valid. New fields are
optional; new rules only warn. Breaking changes are collected for the `1.0`
cut and called out explicitly.

## Versioning

The spec is semver (see `SPEC.md` §Versioning). The top-level `openagent:`
field is optional pre-1.0 (the validator warns when it's missing) and becomes
**required at 1.0**. The `1.0` release is itself an RFC: it freezes the field
set, flips `openagent:` to schema-required, and locks the compatibility
guarantee going forward.

## Index

Accepted/active RFCs live in [`docs/rfcs/`](rfcs/). Historically, the v0.2
additions (provenance, ext, agent_card, face.recipe, badges) were tracked as
DIVE tasks rather than numbered RFCs; from here on, spec changes use this process.
