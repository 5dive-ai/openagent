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
A face should be reproducible by design, not a single fragile PNG. `ref` is the canonical frozen image and `anchor` describes the locked likeness in words; together they keep renders on-model. The optional `recipe` goes one step further — it records *how `ref` was generated* (model + prompt + seed), so the canonical likeness can be **regenerated**, the same way `voice.audio` is reproducible from `base + style`. With a recipe, sprites, reels, and 3D models can all be driven from a freshly re-rendered, identical face instead of upscaling one lossy PNG.

| Field | Req | Notes |
|-------|-----|-------|
| `ref` | ✓ | path/URL to the ONE canonical image. Every render (avatar, sprite, reel, 3D model) must match it. |
| `anchor` | ✓ | text description of the locked likeness, so re-gens stay on-model. |
| `full` | – | optional full-body reference. |
| `sprite` | – | optional sprite sheet of expressions, for animation/feed use. |
| `recipe` | – | optional regeneration recipe so the likeness is reproducible, not just frozen (see below). |

#### `face.recipe`
| Field | Req | Notes |
|-------|-----|-------|
| `model` | ✓ | the named image model that produced `ref` (e.g. `imagen-4`, `flux-1.1-pro`). |
| `prompt` | ✓ | the generation prompt that yields the canonical likeness. |
| `seed` | – | integer or string seed; pin it for deterministic re-gens. Omit if the model exposes none. |

### `voice.audio`
A custom voice is reproducible from its **base + style**, not a fragile per-generation handle — same base + same style yields the same character every time. `ref` optionally anchors it to one canonical clip (like `face.ref` anchors the image); clone that clip once for a stable reusable id.

| Field | Req | Notes |
|-------|-----|-------|
| `base` | ✓ | the named underlying voice (e.g. a Gemini/Flow voice like `Fenrir`, `Sadaltager`). |
| `style` | – | the direction layered on the base: pace, energy, behavior. |
| `ref` | – | path/URL to a canonical ~10s reference clip — the audio anchor. |
| `id` | – | a stable provider voice id if the ref has been cloned (e.g. an ElevenLabs id). |

### `voice.written`
| Field | Req | Notes |
|-------|-----|-------|
| `rules` | ✓ | array of hard constraints. The contract every written output obeys. |
| `sample` | ✓ | one representative line. |

## Design rules

1. **One face, forever.** The whole point is consistency. Changing the *likeness* is a new identity, not an edit. Re-rendering `ref` from the same `face.recipe` (same model, prompt, seed) is not a change — it's the same face, reproduced; that's exactly what the recipe is for.
2. **A persona is portable.** The file is the source of truth; renderers, TTS, and posting bots consume it. No tool-specific fields in the core spec.
3. **Receipts over performance** (recommended convention): personas built for public feeds should tie posts to a real artifact, not generate content for its own sake. Not enforced by schema; encouraged by example.

## Versioning

Spec is semver. Persona files may declare `openagent: "0.1"` at top level (optional in 0.1, required from 1.0).
