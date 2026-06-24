# OpenAgent Specification — v0.2 (draft)

A persona is a single YAML (or JSON) document describing one agent's identity. A conforming file MUST validate against [`schema/persona.schema.json`](./schema/persona.schema.json).

> **v0.2** adds optional per-file **`provenance`** — authorship, an integrity signature, and remix lineage — and a sanctioned **`ext`** extension namespace, on top of v0.1. Everything is additive: a valid v0.1 file is a valid v0.2 file.

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
| `links` | – | object | optional; `avatar`, `profile`, `repo`, and `agent_card` (link to a capability spec — see below). |
| `provenance` | – | object | optional (v0.2); per-file authorship, integrity signature, and remix lineage. |
| `ext` | – | object | optional (v0.2); sanctioned namespace for tool-specific fields, so adopters extend without forking the schema. |

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

### `links`

A free-form string map of external links. A few keys are conventional — `avatar`, `profile`, `repo` — and any other string-valued key is allowed. One key is load-bearing for interop:

| Field | Req | Notes |
|-------|-----|-------|
| `agent_card` | – | URL of this agent's **A2A `AgentCard`** (or an equivalent capability descriptor) — the machine-readable contract of what the agent can *do*: endpoints, skills, auth, I/O modes. |
| `avatar` / `profile` / `repo` | – | canonical avatar image, public profile/home page, source repository. |

**Identity over capability.** Emerging agent-interop standards (Google's [A2A](https://a2aproject.github.io/A2A/) `AgentCard`, and similar agent-card formats) answer *what can this agent do and how do I call it*. OpenAgent answers a different question — *who is this agent*: its face, its voice, how it writes, how it carries itself. Those are orthogonal layers, not competitors. `links.agent_card` is the seam between them: a persona points at its capability card, so a consumer can resolve both the *identity* (from the OpenAgent file) and the *capabilities* (from the linked card) of the same agent. OpenAgent is the **persona layer on top of the capability layer**, never a replacement for it.

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

### `ext` (v0.2, optional)

The core schema is **closed** — every object is `additionalProperties: false`, so an unknown field is a validation error, not a silent passthrough. That keeps the standard honest, but a closed schema gives adopters nowhere to put their own data: their only option would be to fork the schema, and a hundred private forks is how a standard dies.

`ext` is the sanctioned escape hatch. It is one open object at the top level: tool-specific fields live **under `ext`**, namespaced by tool or vendor, and the core spec ignores them.

```yaml
ext:
  acme-studio:        # one namespace per tool/vendor — collisions become impossible
    render_preset: cinematic-4k
    fps: 24
  fivedive:
    dashboard_pinned: true
```

| Rule | Notes |
|------|-------|
| Namespace your keys | each key under `ext` is a tool/vendor namespace (`acme-studio`, a reverse-DNS string, etc.); its value is your free-form object. Two tools never clash. |
| Don't depend on others' namespaces | a conforming tool reads only its own `ext.<self>`; it must tolerate a file with none. |
| Core fields stay core | `ext` is for *tool-specific* data. If something is genuinely about the persona's identity, propose it for the core spec — don't hide it in `ext`. |
| Signed and portable | `ext` is part of the document: it travels with the file and is covered by `provenance` signing. It does **not** affect computed rarity. |

## Design rules

1. **One face, forever.** The whole point is consistency. Changing the *likeness* is a new identity, not an edit. Re-rendering `ref` from the same `face.recipe` (same model, prompt, seed) is not a change — it's the same face, reproduced; that's exactly what the recipe is for.
2. **A persona is portable.** The file is the source of truth; renderers, TTS, and posting bots consume it. No tool-specific fields in the *core* spec — those belong in the open `ext` namespace, so the core stays the same everywhere while adopters still extend it without forking.
3. **Receipts over performance** (recommended convention): personas built for public feeds should tie posts to a real artifact, not generate content for its own sake. Not enforced by schema; encouraged by example.

## Versioning

Spec is semver. Persona files declare their version with a top-level `openagent: "0.2"` (or `"0.1"`). v0.2 is a backward-compatible superset of v0.1: every v0.1 file is valid under v0.2; the only additions are optional.

**The `openagent:` field is optional pre-1.0 and REQUIRED from 1.0.** During the 0.x line a validator that finds the field missing (or set to a version it doesn't recognise) emits a non-fatal **warning** rather than failing — a migration runway so files authored today already carry the field when 1.0 makes it mandatory (schema-required). Always set it.

**Conformance.** A tool may claim *"OpenAgent 0.1 compliant"* (or 0.2) by passing the portable [conformance suite](./conformance/) — a single `manifest.json` of valid/invalid cases with expected verdicts, runnable against any implementation in any language.

**Changes to the spec** go through a lightweight [RFC process](./docs/RFC-PROCESS.md); every release is recorded in the [CHANGELOG](./CHANGELOG.md). The 1.0 cut is itself an RFC that freezes the field set and flips `openagent:` to required.

### Design rule — provenance

4. **A persona is its own receipt.** Authorship and integrity live in the file (`provenance`), not in an external ledger. A signed persona can be verified offline, by anyone, against the key it carries. Forking is declared, not erased: `derived_from` makes remix lineage a first-class edge, turning the registry into a graph instead of a flat list.
