"use strict";

const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

const SCHEMA_PATH = path.join(__dirname, "..", "schema", "persona.schema.json");

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
    return { ok: false, errors: ["top-level document must be a mapping/object"] };
  }

  const validate = getValidator();
  const ok = validate(doc);
  if (ok) {
    return { ok: true, id: doc.id, errors: [] };
  }
  const errors = (validate.errors || []).map(formatError);
  // De-dup (anyOf/oneOf can emit repeats) while preserving order.
  const seen = new Set();
  const unique = errors.filter((m) => (seen.has(m) ? false : (seen.add(m), true)));
  return { ok: false, id: doc.id, errors: unique };
}

// `validate` is the friendly public alias for the doc-level validator.
module.exports = { validateFile, validateDoc, validate: validateDoc, SCHEMA_PATH };
