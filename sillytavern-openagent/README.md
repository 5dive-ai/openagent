# OpenAgent Import — SillyTavern extension

Bring [OpenAgent](https://openagent.5dive.ai) personas into
[SillyTavern](https://github.com/SillyTavern/SillyTavern). Paste (or upload) an
OpenAgent **persona** (`*.persona.yaml` or JSON) or an existing **Character
Card**, and it's converted and imported as a SillyTavern character in one click.

The wedge: unlike a static roleplay card, an OpenAgent persona can be backed by
a **live agent that actually does work** on your own box — a character with a
real agent behind it, not just a chat costume.

## Install

In SillyTavern: **Extensions → Install Extension**, paste this repo's subfolder
URL:

```
https://github.com/5dive/openagent   (path: sillytavern-openagent)
```

Or copy the `sillytavern-openagent/` folder into
`SillyTavern/public/scripts/extensions/third-party/` and reload.

## Use

1. Open the **⚡ Import from OpenAgent** entry in the extensions (wand) menu, or
   the floating ⚡ button (fallback).
2. Paste an OpenAgent persona (YAML or JSON) or a Character Card, or **Load
   file…**.
3. Pick card version (**V3** default, the superset; **V2** for older hosts).
4. **Convert & import** → the character appears in your list.

## How it maps

Conversion mirrors, byte-for-byte, the shipped
[`openagent card --to-charactercard`](https://www.npmjs.com/package/@5dive/openagent)
converter (`@5dive/openagent` v0.39.0, `lib/charactercard.js`):

| OpenAgent persona | Character Card |
|---|---|
| `behavior` | `description` |
| `role` | `personality` |
| `voice.written.sample` | `first_mes` |
| `voice.written.rules` + name/role | composed `system_prompt` |
| `posts_about` | `tags` |
| `org.name` | `creator` |
| `openagent` (version) | `character_version` |

The **whole persona** is stashed under `data.extensions.openagent.persona`, so a
card exported here round-trips losslessly back to the original persona via
`openagent card --from-charactercard` (other hosts ignore the unknown extension
namespace). An already-built Character Card is imported as-is; a bare `data`
object is wrapped.

## Scope note (why no "live brain" mode)

An earlier plan was to point SillyTavern at a running 5dive agent as an
OpenAI-compatible backend. That path is **not supported**: 5dive exposes no
OpenAI-compatible HTTP endpoint (agents are coordinating coding CLIs, not chat
servers), and exposing one as a roleplay proxy brushes the ToS-sensitive proxy
line. The real distribution lever is **persona portability via the card**; the
extension links out to the live-agent product rather than proxying completions.

## Notes

- Import posts to SillyTavern's `/api/characters/import` (field `avatar`,
  `file_type=json`) using the app's own request headers (CSRF-safe).
- The bundled YAML parser covers the OpenAgent persona shape (nested maps,
  sequences, flow arrays, block/folded scalars, inline comments). If something
  won't parse, paste JSON or run the CLI converter and paste its output.

MIT, © 5dive.
