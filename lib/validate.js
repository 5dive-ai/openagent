"use strict";

const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

const SCHEMA_PATH = path.join(__dirname, "..", "schema", "persona.schema.json");

// The spec version this implementation validates against, and every version
// it knows how to read. A v0.2 validator accepts every v0.1 file (additive
// superset), so both are "known". Bump KNOWN_VERSIONS when a new minor ships.
const SPEC_VERSION = "0.2";
const KNOWN_VERSIONS = ["0.1", "0.2"];

// Non-fatal advisories about the top-level `openagent:` version field.
//
// The field is OPTIONAL pre-1.0 and REQUIRED from 1.0 (SPEC §Versioning). To
// give adopters a migration runway we *warn* now and will *enforce* (move it
// into schema.required) at the 1.0 cut — so files authored today already carry
// the field by the time it becomes mandatory. Warnings never fail validation:
// `ok` stays true, callers may surface or ignore them.
function versionWarnings(doc) {
  const w = [];
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return w;
  const v = doc.openagent;
  if (v === undefined || v === null) {
    w.push(
      `missing top-level 'openagent' version field — optional pre-1.0 but REQUIRED from spec 1.0. ` +
        `Add: openagent: "${SPEC_VERSION}"`
    );
  } else if (typeof v === "string" && !KNOWN_VERSIONS.includes(v)) {
    w.push(
      `unrecognised spec version 'openagent: "${v}"' — this tool implements ` +
        `${KNOWN_VERSIONS.map((x) => `"${x}"`).join(", ")}; validated against the latest known schema (v${SPEC_VERSION}).`
    );
  }
  return w;
}

let _validator = null;
function getValidator() {
  if (_validator) return _validator;
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false, verbose: true });
  addFormats(ajv);
  _validator = ajv.compile(schema);
  return _validator;
}

// Turn one Ajv error into a single human-readable line.
function formatError(err) {
  const where = err.instancePath ? err.instancePath.replace(/\//g, ".") : "(root)";
  switch (err.keyword) {
    case "required":
      return `${where}: missing required field '${err.params.missingProperty}'`;
    case "additionalProperties":
      return `${where}: unknown field '${err.params.additionalProperty}' (not in the OpenAgent spec)`;
    case "pattern":
      return `${where}: '${err.data}' does not match required pattern ${err.params.pattern}`;
    case "minItems":
      return `${where}: must have at least ${err.params.limit} item(s)`;
    case "minProperties":
      return `${where}: must have at least ${err.params.limit} field(s) (voice needs audio and/or written)`;
    case "type":
      return `${where}: must be ${err.params.type}`;
    case "enum":
      return `${where}: must be one of ${JSON.stringify(err.params.allowedValues)}`;
    default:
      return `${where}: ${err.message}`;
  }
}

/**
 * Validate a single persona file.
 * @returns {{ file: string, ok: boolean, id?: string, errors: string[] }}
 */
function validateFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { file, ok: false, errors: [`cannot read file: ${e.message}`] };
  }

  let doc;
  try {
    // YAML.parse handles both YAML and JSON (JSON is a YAML subset).
    doc = YAML.parse(raw);
  } catch (e) {
    return { file, ok: false, errors: [`not valid YAML/JSON: ${e.message}`] };
  }

  return { file, ...validateDoc(doc) };
}

/**
 * Validate an already-parsed persona document against the v0.1 schema.
 * The doc-level counterpart to validateFile — handy for callers that already
 * hold the parsed object (e.g. the gallery's cardEntryFromPersona feeding the
 * verdict straight into computeTier as ctx.schemaValid).
 * @returns {{ ok: boolean, id?: string, errors: string[] }}
 */
function validateDoc(doc) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, errors: ["top-level document must be a mapping/object"], warnings: [] };
  }

  const warnings = versionWarnings(doc);
  const validate = getValidator();
  const ok = validate(doc);
  if (ok) {
    return { ok: true, id: doc.id, errors: [], warnings };
  }
  const errors = (validate.errors || []).map(formatError);
  // De-dup (anyOf/oneOf can emit repeats) while preserving order.
  const seen = new Set();
  const unique = errors.filter((m) => (seen.has(m) ? false : (seen.add(m), true)));
  return { ok: false, id: doc.id, errors: unique, warnings };
}

// `validate` is the friendly public alias for the doc-level validator.
module.exports = {
  validateFile,
  validateDoc,
  validate: validateDoc,
  versionWarnings,
  SCHEMA_PATH,
  SPEC_VERSION,
  KNOWN_VERSIONS,
};
