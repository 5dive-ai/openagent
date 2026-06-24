# OpenAgent conformance suite

This directory is how a tool earns the right to say **"OpenAgent 0.1
compliant"** (or 0.2). It is a single portable file —
[`manifest.json`](manifest.json) — holding a list of cases. Each case carries
an inline persona document, the **spec level** it belongs to, and the expected
verdict (`valid` / `invalid`, plus required error/warning substrings).

The manifest is deliberately language-agnostic: no YAML, no file paths, no
dependency on this repo's code. A validator written in any language can load
it, feed each case's `doc` to its own implementation, and check the result.

## Compliance levels

- **OpenAgent 0.1 compliant** — your validator agrees with every case tagged
  `"spec": "0.1"`.
- **OpenAgent 0.2 compliant** — every `0.1` **and** `0.2` case. (0.2 is an
  additive superset of 0.1: provenance, `ext`, `links.agent_card`, `face.recipe`.)

A case's `expect` is the verdict your validator must produce. For `invalid`
cases, `expect_errors` lists substrings that must appear somewhere in your
errors (wording is yours; the substrings name the *reason*). `expect_warnings`
lists non-fatal advisories (e.g. the missing-version warning) — a case can be
`valid` and still carry warnings.

## Running it (this implementation)

```sh
npm run test:conformance         # all levels
node test/conformance.js 0.1     # just the 0.1 floor
```

It also runs as part of `npm test`.

## Running it (your own tool, any language)

```python
import json
suite = json.load(open("conformance/manifest.json"))
for case in suite["cases"]:
    if case["spec"] not in ("0.1",):          # the levels you claim
        continue
    result = my_validator(case["doc"])         # -> {"ok": bool, "errors": [...]}
    got = "valid" if result["ok"] else "invalid"
    assert got == case["expect"], case["name"]
    for needle in case.get("expect_errors", []):
        assert any(needle in e for e in result["errors"]), (case["name"], needle)
```

## Adding cases

New spec behaviour must land a conformance case (at least one `valid` and one
`invalid`) in the same PR — see [`../docs/RFC-PROCESS.md`](../docs/RFC-PROCESS.md).
Keep each `doc` minimal: only the fields the case is about, plus the required
core so it's otherwise well-formed.
