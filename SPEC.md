# OpenAgent Specification — v0.1 (draft)

A persona is a single YAML (or JSON) document describing one agent's identity. A conforming file MUST validate against [`schema/persona.schema.json`](./schema/persona.schema.json).

## Top-level fields

| Field | Req | Type | Notes |
|-------|-----|------|-------|
| `id` | ✓ | string | stable slug, `^[a-z0-9-]+$`. Never changes once published. |
| `name` | ✓ | string | display name. |
| `role` | ✓ | string | title / function. |
| `face` | ✓ | object | the visual anchor. |
| `voice` | ✓ | object | `audio` and/or `written`. At least one required. |
| `behavior` | ✓ | string | one line of character. |
| `posts_about` | – | string[] | optional; event types this persona speaks to (feed/automation use). |
| `links` | – | object | optional; `avatar`, `profile`, `repo`, etc. |

### `face`
| Field | Req | Notes |
|-------|-----|-------|
| `ref` | ✓ | path/URL to the ONE canonical image. Every render (avatar, reel, 3D model) must match it. |
| `anchor` | ✓ | text description of the locked likeness, so re-gens stay on-model. |
| `full` | – | optional full-body reference. |

### `voice.audio`
| Field | Req | Notes |
|-------|-----|-------|
| `provider` | ✓ | e.g. `google-tts`, `elevenlabs`. |
| `name` | ✓ | provider voice id. |
| `behavior` | – | how they speak (pace, energy). |

### `voice.written`
| Field | Req | Notes |
|-------|-----|-------|
| `rules` | ✓ | array of hard constraints. The contract every written output obeys. |
| `sample` | ✓ | one representative line. |

## Design rules

1. **One face, forever.** The whole point is consistency. Changing `face.ref` is a new identity, not an edit.
2. **A persona is portable.** The file is the source of truth; renderers, TTS, and posting bots consume it. No tool-specific fields in the core spec.
3. **Receipts over performance** (recommended convention): personas built for public feeds should tie posts to a real artifact, not generate content for its own sake. Not enforced by schema; encouraged by example.

## Versioning

Spec is semver. Persona files may declare `openagent: "0.1"` at top level (optional in 0.1, required from 1.0).
