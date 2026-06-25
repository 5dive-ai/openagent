# Publishing the persona schema to SchemaStore

[SchemaStore.org](https://www.schemastore.org/) is the registry the major
editors (VS Code, Visual Studio, JetBrains via the JSON Schema Store plugin,
and any YAML-language-server client) consult to auto-apply a JSON Schema by
filename. Once our entry is merged, anyone editing a `*.persona.yaml` gets
**autocomplete + inline validation** with zero per-repo config — the single
biggest drop in authoring friction.

## What's already done in this repo

- `schema/persona.schema.json` is the published schema. Its `$id` is the stable
  raw URL SchemaStore will point at:
  `https://raw.githubusercontent.com/5dive-ai/openagent/main/schema/persona.schema.json`
- `schema/schemastore.catalog.json` is the exact catalog entry to submit
  (name, description, `fileMatch`, `url`).

## Submitting (one-time, external PR)

SchemaStore accepts new schemas via PR to
[`SchemaStore/schemastore`](https://github.com/SchemaStore/schemastore). This is
a third-party repo, so the merge is on their maintainers — but the change on our
side is small and mechanical:

1. Fork `SchemaStore/schemastore`.
2. Add the contents of `schema/schemastore.catalog.json` (minus the `_comment`
   key) to `src/api/json/catalog.json`, inserted **alphabetically by `name`**
   into the `schemas` array.
3. SchemaStore prefers a self-hosted copy of the schema. Either:
   - **Reference our raw URL** (allowed; keep `url` as-is), or
   - **Vendor a copy** at `src/schemas/json/openagent-persona.json` and set
     `url` to `https://json.schemastore.org/openagent-persona.json`.
   Referencing our raw URL keeps a single source of truth, so prefer it unless a
   maintainer asks for a vendored copy.
4. Run their `npm run build` / `npm test` (validates the catalog + schema), open
   the PR, and link this repo.

## Local / editor opt-in before the PR merges

Adopters don't have to wait for SchemaStore. Either works today:

**VS Code (`.vscode/settings.json`)** — YAML extension:

```json
{
  "yaml.schemas": {
    "https://raw.githubusercontent.com/5dive-ai/openagent/main/schema/persona.schema.json": "*.persona.yaml"
  }
}
```

**Inline modeline** at the top of any persona file:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/5dive-ai/openagent/main/schema/persona.schema.json
```

JSON files can reference it directly with a `$schema` key.
