"use strict";

// Per-file provenance for OpenAgent personas (spec v0.2).
//
// The registry manifest is signed (lib/registry.js), but the *persona file*
// itself carried no authorship or integrity proof. provenance closes that gap,
// additively and back-compat:
//
//   provenance:
//     created_by: { name, key, url }   # key = ed25519 public key (the identity)
//     signed_at: <ISO8601>
//     derived_from: [{ id, source, relation, signature }]   # remix lineage
//     signature: <base64 ed25519>      # over the canonical doc, sig removed
//
// The signature is SELF-VERIFYING: it is checked against created_by.key, which
// lives in the file. That proves two things together — integrity (the content
// wasn't altered after signing) and key-authorship (whoever holds the private
// half of created_by.key produced it). It is a self-asserted identity (TOFU),
// not a CA chain — the honest, decentralised model that fits "receipts over
// performance": a persona ships with its receipt or it doesn't.
//
// derived_from records the remix graph. Forking marcus into your own persona is
// a first-class, declared edge — that lineage is what turns the registry into a
// growing graph instead of a flat list.

const crypto = require("crypto");

// ---- canonicalisation -------------------------------------------------------

// Deterministic JSON: object keys sorted recursively, no insignificant
// whitespace. Two documents that differ only in key order / formatting produce
// identical bytes, so a YAML round-trip (which may reorder keys) never breaks a
// signature.
function stableStringify(v) {
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  if (v && typeof v === "object") {
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + stableStringify(v[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(v); // strings/numbers/booleans/null
}

// The exact bytes a signature covers: the whole persona document with
// provenance.signature removed (everything else — created_by, signed_at,
// derived_from — is signed). Round-trips through JSON to drop undefined.
function canonicalBytes(doc) {
  const clone = JSON.parse(JSON.stringify(doc));
  if (clone.provenance && typeof clone.provenance === "object") {
    delete clone.provenance.signature;
  }
  return Buffer.from(stableStringify(clone), "utf8");
}

// ---- key handling -----------------------------------------------------------

// Accept either a PEM block or a bare base64 SPKI/PKCS8 DER body, so personas
// can embed a compact one-line key instead of a multi-line PEM if they prefer.
function toPublicKey(key) {
  const s = String(key).trim();
  if (s.includes("BEGIN")) return crypto.createPublicKey(s);
  return crypto.createPublicKey({ key: Buffer.from(s, "base64"), format: "der", type: "spki" });
}
function toPrivateKey(key) {
  const s = String(key).trim();
  if (s.includes("BEGIN")) return crypto.createPrivateKey(s);
  return crypto.createPrivateKey({ key: Buffer.from(s, "base64"), format: "der", type: "pkcs8" });
}

// Public PEM derived from a private key — what gets embedded as created_by.key.
function publicPemFromPrivate(privateKey) {
  const pub = crypto.createPublicKey(toPrivateKey(privateKey));
  return pub.export({ type: "spki", format: "pem" }).toString().trim();
}

// Fresh ed25519 identity. publicKey is the persona's stable identity anchor;
// the private half stays with the author and never enters a persona file.
function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString().trim(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim(),
  };
}

// ---- sign / verify ----------------------------------------------------------

/**
 * Return a signed copy of `doc`. Embeds created_by.key (derived from the
 * private key), records signed_at, and appends provenance.signature over the
 * canonical document. Pure: the input is not mutated.
 * @param {object} doc
 * @param {{privateKey:string, name?:string, url?:string, signedAt?:string}} opts
 */
function signPersona(doc, opts = {}) {
  if (!opts.privateKey) throw new Error("signPersona: privateKey required");
  const out = JSON.parse(JSON.stringify(doc));
  out.provenance = out.provenance && typeof out.provenance === "object" ? out.provenance : {};
  out.provenance.created_by = Object.assign({}, out.provenance.created_by, {
    key: publicPemFromPrivate(opts.privateKey),
  });
  if (opts.name) out.provenance.created_by.name = opts.name;
  if (opts.url) out.provenance.created_by.url = opts.url;
  if (opts.signedAt) out.provenance.signed_at = opts.signedAt;
  delete out.provenance.signature; // signed_at/created_by are in scope, signature is not
  const bytes = canonicalBytes(out);
  out.provenance.signature = crypto.sign(null, bytes, toPrivateKey(opts.privateKey)).toString("base64");
  return out;
}

/**
 * Verify a persona's per-file signature against its embedded created_by.key.
 * Never throws — malformed keys/signatures resolve to ok:false with a reason.
 * @returns {{signed:boolean, ok:boolean, reason:string, createdBy?:object, derivedFrom?:Array}}
 */
function verifyPersona(doc) {
  const prov = doc && typeof doc === "object" ? doc.provenance : null;
  const out = {
    signed: !!(prov && prov.signature),
    ok: false,
    reason: "",
    createdBy: prov && prov.created_by ? prov.created_by : undefined,
    derivedFrom: prov && Array.isArray(prov.derived_from) ? prov.derived_from : undefined,
  };
  if (!prov || !prov.signature) {
    out.reason = "no signature";
    return out;
  }
  const key = prov.created_by && prov.created_by.key;
  if (!key) {
    out.reason = "signature present but provenance.created_by.key is missing";
    return out;
  }
  let publicKey;
  try {
    publicKey = toPublicKey(key);
  } catch (e) {
    out.reason = "created_by.key is not a usable ed25519 public key: " + e.message;
    return out;
  }
  let valid;
  try {
    valid = crypto.verify(null, canonicalBytes(doc), publicKey, Buffer.from(String(prov.signature).trim(), "base64"));
  } catch (e) {
    out.reason = "signature could not be verified: " + e.message;
    return out;
  }
  out.ok = valid;
  out.reason = valid ? "valid" : "signature does not match the content or key (tampered or wrong key)";
  return out;
}

module.exports = {
  stableStringify,
  canonicalBytes,
  generateKeypair,
  publicPemFromPrivate,
  signPersona,
  verifyPersona,
  toPublicKey,
  toPrivateKey,
};
