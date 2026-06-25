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

// ---- did:key public address -------------------------------------------------
//
// A persona's public key (created_by.key) is an ed25519 SPKI PEM — verifiable
// but not a portable, copy-pasteable handle. did:key is the W3C-standard way to
// express a raw public key as a self-describing address (no registry, no
// network): multibase-base58btc( multicodec-ed25519-pub(0xed 0x01) || raw32 ),
// prefixed "did:key:". Ed25519 keys always render as did:key:z6Mk… — that string
// IS the agent's canonical public address, interoperable with the wider DID /
// agent-identity ecosystem (DIVE-653: identity layer over A2A/AgentCard).

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// Bitcoin/IPFS base58btc encode (no checksum). Leading zero bytes → leading "1".
function base58btcEncode(bytes) {
  const buf = Buffer.from(bytes);
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros++;
  const digits = [0];
  for (let i = zeros; i < buf.length; i++) {
    let carry = buf[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

// Raw 32-byte ed25519 public key from any accepted key form (PEM/DER/JWK route).
// Uses JWK export so we never hand-parse SPKI DER offsets.
function rawEd25519PublicKey(key) {
  const pub = toPublicKey(key);
  const jwk = pub.export({ format: "jwk" });
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
    throw new Error("not an Ed25519 public key (did:key needs ed25519)");
  }
  const raw = Buffer.from(jwk.x, "base64url");
  if (raw.length !== 32) throw new Error(`unexpected ed25519 key length: ${raw.length}`);
  return raw;
}

/**
 * Derive the did:key public address for an ed25519 public key. Accepts a PEM
 * block, a bare base64 SPKI body, or anything toPublicKey understands.
 * @returns {string} e.g. "did:key:z6Mk..."
 */
function didKeyFromPublicKey(key) {
  const raw = rawEd25519PublicKey(key);
  const prefixed = Buffer.concat([Buffer.from([0xed, 0x01]), raw]); // 0xed01 = ed25519-pub
  return "did:key:z" + base58btcEncode(prefixed);
}

// Short, human-glanceable tail of a did:key — the verifiable handle printed on a
// card. Keeps the "z" multibase marker + last `n` chars so it reads as a did.
function shortDidKey(did, n = 8) {
  const s = String(did || "");
  if (!s.startsWith("did:key:")) return s;
  const body = s.slice("did:key:".length); // z6Mk...
  return body.length <= n + 1 ? body : "z…" + body.slice(-n);
}

// ── Friendly ID (handle·fingerprint) ──────────────────────────────────────
// The did:key is unique+verifiable but ugly (48 chars). A friendly id pairs the
// human handle (persona.id) with a short fingerprint DERIVED from the did:key:
// `marcus·k7f2q9`. Memorable, collision-safe across same-named agents, and still
// verifiable — anyone can recompute the fingerprint from the did:key (see
// verifyFriendlyId), so a handle can't be spoofed onto someone else's key.
//
// Fingerprint alphabet: Crockford base32, lowercase, minus i/l/o/u (no
// look-alikes). 6 chars = 30 bits ≈ 1e9 space — ample to disambiguate handles.
const FP_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
function fingerprintFromDidKey(did, len = 6) {
  if (!did || typeof did !== "string") throw new Error("fingerprint needs a did:key string");
  const h = crypto.createHash("sha256").update(did).digest();
  let bits = 0, val = 0, out = "";
  for (let i = 0; i < h.length && out.length < len; i++) {
    val = (val << 8) | h[i];
    bits += 8;
    while (bits >= 5 && out.length < len) {
      out += FP_ALPHABET[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

// Compose the friendly id from a handle + did:key.
// → { handle, fingerprint, did, display: "handle·fp", urlSafe: "handle-fp" }
function friendlyId(handle, did, opts = {}) {
  const len = opts.len || 6;
  const h = String(handle || "").trim();
  if (!h) throw new Error("friendlyId needs a handle");
  const fingerprint = fingerprintFromDidKey(did, len);
  return { handle: h, fingerprint, did, display: `${h}·${fingerprint}`, urlSafe: `${h}-${fingerprint}` };
}

// Verify a claimed friendly id against a did:key (+ optional expected handle).
// Accepts "handle·fp", "handle-fp", or a bare "fp". Recomputes the fingerprint
// from the did:key and checks it matches; if the claim carries a handle, it must
// match too. This is the gallery's anti-impersonation check.
// → { ok, reason, fingerprint } where fingerprint is the CORRECT one.
function verifyFriendlyId(claimed, did, expectedHandle = null) {
  const correct = fingerprintFromDidKey(did, 6);
  const norm = String(claimed || "").trim().replace(/·/g, "-");
  const parts = norm.split("-").filter(Boolean);
  const claimedFp = parts.length ? parts.pop() : "";
  const claimedHandle = parts.join("-"); // handle may itself contain hyphens
  if (!claimedFp) return { ok: false, reason: "no fingerprint in claim", fingerprint: correct };
  if (claimedFp !== correct) return { ok: false, reason: "fingerprint does not match did:key", fingerprint: correct };
  if (claimedHandle && expectedHandle && claimedHandle !== String(expectedHandle)) {
    return { ok: false, reason: `handle "${claimedHandle}" ≠ persona id "${expectedHandle}"`, fingerprint: correct };
  }
  return { ok: true, reason: "matches", fingerprint: correct };
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
 * @returns {{signed:boolean, ok:boolean, reason:string, did?:string, createdBy?:object, derivedFrom?:Array}}
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
  // Resolve the public address the signature is checked against — "this card
  // really is did:key:z6Mk…" — so callers can show/compare it.
  try {
    out.did = didKeyFromPublicKey(key);
  } catch (_) {
    /* non-ed25519 key: leave did unset, signature check below still runs */
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
  base58btcEncode,
  didKeyFromPublicKey,
  shortDidKey,
  fingerprintFromDidKey,
  friendlyId,
  verifyFriendlyId,
};
