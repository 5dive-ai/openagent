---
rfc: 0000
title: <short title>
status: draft        # draft | accepted | rejected | postponed
spec_target: 0.x    # the spec version this would land in
author: <name/handle>
created: <YYYY-MM-DD>
---

# RFC 0000: <title>

## Summary

One paragraph: what changes, in plain terms.

## Motivation

What problem does this solve? Who hits it today, and what do they do instead?
Why does it belong in the spec rather than in `ext` or a single tool?

## Proposal

The concrete change. Show the new/changed fields with a YAML example. If it
touches the schema, sketch the `schema/persona.schema.json` diff.

```yaml
openagent: "0.x"
id: example
# ... the new shape in context ...
```

## Compatibility

Is every existing valid file still valid? (Pre-1.0 the answer MUST be yes.)
If a field becomes required or a rule tightens, describe the warn-then-enforce
runway and what migrates files in the meantime.

## Conformance

Which `conformance/manifest.json` cases get added — at least one valid and one
invalid case exercising the new behaviour, tagged with the right spec level.

## Alternatives considered

What else was on the table, and why this won.

## Unresolved questions

Anything deferred to implementation or a later RFC.
