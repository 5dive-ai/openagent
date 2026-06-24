# OpenAgent Specification — v0.2 (draft)

A persona is a single YAML (or JSON) document describing one agent's identity. A conforming file MUST validate against [`schema/persona.schema.json`](./schema/persona.schema.json).

> **v0.2** adds optional per-file **`provenance`** — authorship, an integrity signature, and remix lineage — on top of v0.1. Everything is additive: a valid v0.1 file is a valid v0.2 file.

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
| `provenance` | – | object | optional (v0.2); per-file authorship, integrity signature, and remix lineage. |

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

### `provenance` (v0.2, optional)

v0.1 left the persona *file* unproven: only the Mythical registry manifest was signed, so a file on disk carried no authorship or integrity proof. `provenance` adds that, per file — additive and back-compat.

| Field | Req | Notes |
|-------|-----|-------|
| `created_by` | – | the authoring identity. The ed25519 `key` IS the identity; `name`/`url` are human labels. |
| `signed_at` | – | ISO 8601 timestamp; covered by the signature. |
| `derived_from` | – | remix lineage — the parent persona(s) this one was forked/remixed from. |
| `signature` | – | detached ed25519 signature (base64) over the canonical file with this field removed. |

#### `created_by`
| Field | Req | Notes |
|-------|-----|-------|
| `key` | ✓ | ed25519 public key (PEM block or bare base64 SPKI) the signature verifies against. |
| `name` | – | human-readable author label. |
| `url` | – | link to the author (profile, repo, site). |

#### `derived_from[]`
| Field | Req | Notes |
|-------|-----|-------|
| `id` | ✓ | the parent persona's id. |
| `source` | – | where the parent file lives (URL/path), so the lineage is resolvable. |
| `relation` | – | `fork` \| `remix` \| `inspired_by`. Defaults to `fork`. |
| `signature` | – | the parent's `provenance.signature` at fork time, pinning the exact revision forked. |

**Signing & verifying.** The signature is computed over the *canonical* document — the persona with `provenance.signature` removed, serialized as JSON with object keys sorted recursively and no insignificant whitespace. Because it canonicalizes, a YAML round-trip (which may reorder keys) never invalidates a signature. Verification re-derives those bytes and checks them against `provenance.created_by.key`. This is **self-verifying**: the key lives in the file, so a valid signature proves both *integrity* (the content wasn't altered after signing) and *key-authorship* (the holder of that key's private half signed it). It is a self-asserted identity (trust-on-first-use), not a CA chain — fitting "receipts over performance": the file ships with its own receipt.

The CLI provides `openagent keygen`, `openagent sign <file> --key <privkey>`, and `openagent verify <file>`. See [`examples/marcus-ops.persona.yaml`](./examples/marcus-ops.persona.yaml) for a signed fork with lineage.

## Design rules

1. **One face, forever.** The whole point is consistency. Changing the *likeness* is a new identity, not an edit. Re-rendering `ref` from the same `face.recipe` (same model, prompt, seed) is not a change — it's the same face, reproduced; that's exactly what the recipe is for.
2. **A persona is portable.** The file is the source of truth; renderers, TTS, and posting bots consume it. No tool-specific fields in the core spec.
3. **Receipts over performance** (recommended convention): personas built for public feeds should tie posts to a real artifact, not generate content for its own sake. Not enforced by schema; encouraged by example.

## Versioning

Spec is semver. Persona files may declare `openagent: "0.2"` (or `"0.1"`) at top level (optional pre-1.0, required from 1.0). v0.2 is a backward-compatible superset of v0.1: every v0.1 file is valid under v0.2; the only additions are optional.

### Design rule — provenance

4. **A persona is its own receipt.** Authorship and integrity live in the file (`provenance`), not in an external ledger. A signed persona can be verified offline, by anyone, against the key it carries. Forking is declared, not erased: `derived_from` makes remix lineage a first-class edge, turning the registry into a graph instead of a flat list.
