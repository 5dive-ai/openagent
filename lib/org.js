"use strict";

// did:web org verification for OpenAgent personas (spec v0.2, additive).
//
// THE PROBLEM. `org.name: "5dive"` is a free-text claim — anyone can stamp any
// brand on their card (the placeholder-org warning in validate.js exists exactly
// because that's so easy). provenance.js proves *who the agent is* (its did:key);
// it says nothing about *who it works for*. So org affiliation has been an
// unverifiable performance, the deepest remaining impersonation hole.
//
// THE FIX (did:web). An org proves control of its domain by publishing a key at
//   https://<domain>/.well-known/openagent.json
// — its did:web document. To vouch for an agent, the org signs a tiny
// attestation binding the agent's did:key to the org's did:web, and the agent
// embeds it under `org.verification`. A verifier then:
//   1. resolves did:web:<domain> → fetches the well-known doc → gets the org key,
//   2. checks the attestation signature against that key,
//   3. checks the attestation's `agent` equals the persona's OWN did:key.
// All three must hold. Only someone who controls the domain (publishes the
// well-known file) AND holds the org private key can mint a passing attestation,
// and it only passes for the one agent identity it names. That's a *verified ORG
// badge*, not a self-claim — and it kills org impersonation.
//
// Trust anchor = the domain, exactly like a TLS cert or did:web DID. We never
// embed the org key in the persona (that would let a forger ship their own key);
// the key always comes from the live domain.

const crypto = require("crypto");
const prov = require("./provenance");

const ORG_DOC_VERSION = "0.1";
const WELL_KNOWN_FILE = "openagent.json";

// ---- did:web <-> URL --------------------------------------------------------

// Turn an org home URL into its did:web identifier (W3C did:web rules):
//   https://5dive.com            → did:web:5dive.com
//   https://5dive.com/teams/x    → did:web:5dive.com:teams:x
//   https://host:3000            → did:web:host%3A3000   (port is percent-enc'd)
function didWebFromUrl(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch (e) {
    throw new Error(`org url is not a valid URL: ${url}`);
  }
  if (u.protocol !== "https:" && u.hostname !== "localhost") {
    throw new Error(`did:web requires https (got ${u.protocol}//)`);
  }
  let id = u.hostname;
  if (u.port) id += "%3A" + u.port;
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length) id += ":" + segs.map(encodeURIComponent).join(":");
  return "did:web:" + id;
}

// Resolve a did:web to the URL of its OpenAgent well-known document.
//   did:web:5dive.com         → https://5dive.com/.well-known/openagent.json
//   did:web:5dive.com:teams:x → https://5dive.com/teams/x/openagent.json
// (Domain-only DIDs use /.well-known/ per spec; path DIDs use the path itself.)
function wellKnownUrlForDid(did) {
  const s = String(did || "").trim();
  if (!s.startsWith("did:web:")) throw new Error(`not a did:web: ${did}`);
  const parts = s.slice("did:web:".length).split(":");
  const host = decodeURIComponent(parts.shift()).replace("%3A", ":");
  const base = "https://" + host;
  if (parts.length === 0) return `${base}/.well-known/${WELL_KNOWN_FILE}`;
  return `${base}/${parts.map(decodeURIComponent).join("/")}/${WELL_KNOWN_FILE}`;
}

// ---- the org well-known document --------------------------------------------

// Build the JSON an org publishes at its well-known path. Derives the public org
// key(s) from private key(s) — the private half never leaves the org operator.
// @param {{url:string, name:string, privateKey:string|string[], keyId?:string|string[]}} opts
function buildOrgDoc(opts = {}) {
  if (!opts.url) throw new Error("buildOrgDoc: url required (the org home, e.g. https://5dive.com)");
  if (!opts.name) throw new Error("buildOrgDoc: name required (display name, e.g. 5dive)");
  const did = didWebFromUrl(opts.url);
  const privs = Array.isArray(opts.privateKey) ? opts.privateKey : [opts.privateKey];
  const ids = Array.isArray(opts.keyId) ? opts.keyId : [opts.keyId];
  if (!privs[0]) throw new Error("buildOrgDoc: privateKey required");
  const keys = privs.map((pk, i) => ({
    id: ids[i] || `org-${i + 1}`,
    type: "Ed25519",
    key: prov.publicPemFromPrivate(pk),
  }));
  return {
    openagent_org: ORG_DOC_VERSION,
    did,
    name: String(opts.name),
    url: String(opts.url),
    keys,
  };
}

// ---- the attestation (what the org signs) -----------------------------------

// The exact fields an org attestation covers — minimal and stable. Binding the
// agent's did:key is the whole point: the signature is non-transferable to any
// other identity. Ordering is irrelevant (canonicalised before signing).
function attestationPayload({ did, agent, issued_at }) {
  const p = { did: String(did), agent: String(agent) };
  if (issued_at) p.issued_at = String(issued_at);
  return p;
}
function canonicalAttestationBytes(payload) {
  return Buffer.from(prov.stableStringify(attestationPayload(payload)), "utf8");
}

// Resolve the agent's own did:key from its persona (the identity being vouched
// for). Returns null when the persona carries no provenance key — without it
// there is nothing to bind an org attestation to.
function agentDidFromPersona(persona) {
  const key = persona && persona.provenance && persona.provenance.created_by && persona.provenance.created_by.key;
  if (!key) return null;
  try {
    return prov.didKeyFromPublicKey(key);
  } catch (_) {
    return null;
  }
}

// Mint an org attestation for an agent and return the `org.verification` block
// to embed in the persona. The org operator runs this with the org private key.
// @param {{ agentDid:string, orgUrl?:string, orgDid?:string, keyId?:string, issuedAt?:string }} opts
function signOrgAttestation(orgPrivateKey, opts = {}) {
  if (!orgPrivateKey) throw new Error("signOrgAttestation: org privateKey required");
  if (!opts.agentDid) throw new Error("signOrgAttestation: agentDid required (the did:key being vouched for)");
  const did = opts.orgDid || (opts.orgUrl && didWebFromUrl(opts.orgUrl));
  if (!did) throw new Error("signOrgAttestation: orgDid or orgUrl required");
  const payload = { did, agent: opts.agentDid, issued_at: opts.issuedAt };
  const sig = crypto.sign(null, canonicalAttestationBytes(payload), prov.toPrivateKey(orgPrivateKey));
  const block = { did, agent: opts.agentDid, signature: sig.toString("base64") };
  if (opts.keyId) block.key_id = opts.keyId;
  if (opts.issuedAt) block.issued_at = opts.issuedAt;
  return block;
}

// ---- verification (the trust check) -----------------------------------------

/**
 * Verify an agent's org affiliation by resolving the org's did:web document and
 * checking the embedded attestation. Networked: `resolve(wellKnownUrl)` fetches
 * and returns the parsed org doc (injected so callers control fetch/caching and
 * tests stay offline). Never throws.
 *
 * @param {object} persona
 * @param {{ resolve:(url:string)=>Promise<object> }} opts
 * @returns {Promise<{verified:boolean, reason:string, org?:{did,name,url}, agent?:string, keyId?:string, nameMatches?:boolean}>}
 */
async function verifyOrgAffiliation(persona, opts = {}) {
  const v = persona && persona.org && persona.org.verification;
  if (!v) return { verified: false, reason: "no org.verification block (org affiliation is self-declared only)" };
  if (!v.signature || !v.did || !v.agent) {
    return { verified: false, reason: "org.verification is incomplete (needs did, agent, signature)" };
  }
  // 1. The attestation must name THIS agent's own did:key.
  const agentDid = agentDidFromPersona(persona);
  if (!agentDid) {
    return { verified: false, reason: "persona has no provenance.created_by.key — nothing to bind the org attestation to" };
  }
  if (agentDid !== v.agent) {
    return { verified: false, reason: `attestation is for ${v.agent}, but this persona's identity is ${agentDid}` };
  }
  // 2. Resolve the org's did:web well-known document.
  let url, doc;
  try {
    url = wellKnownUrlForDid(v.did);
  } catch (e) {
    return { verified: false, reason: e.message };
  }
  if (typeof opts.resolve !== "function") {
    return { verified: false, reason: "no resolver provided (cannot fetch the org's did:web document)" };
  }
  try {
    doc = await opts.resolve(url);
  } catch (e) {
    return { verified: false, reason: `could not fetch org document at ${url}: ${e.message}` };
  }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.keys)) {
    return { verified: false, reason: `org document at ${url} is missing or has no keys[]` };
  }
  if (doc.did && doc.did !== v.did) {
    return { verified: false, reason: `org document declares ${doc.did}, attestation claims ${v.did}` };
  }
  // 3. Check the signature against the org key(s). If key_id is named, only that
  //    key may sign (rotation-safe); otherwise any published key is accepted.
  const candidates = v.key_id ? doc.keys.filter((k) => k.id === v.key_id) : doc.keys;
  if (!candidates.length) {
    return { verified: false, reason: v.key_id ? `org document has no key with id "${v.key_id}"` : "org document has no usable keys" };
  }
  const bytes = canonicalAttestationBytes({ did: v.did, agent: v.agent, issued_at: v.issued_at });
  const sig = Buffer.from(String(v.signature).trim(), "base64");
  let signedBy = null;
  for (const k of candidates) {
    try {
      if (crypto.verify(null, bytes, prov.toPublicKey(k.key), sig)) {
        signedBy = k.id;
        break;
      }
    } catch (_) {
      /* unusable key entry — skip */
    }
  }
  if (!signedBy) {
    return { verified: false, reason: "attestation signature does not match any published org key (forged, tampered, or rotated out)" };
  }
  // Verified. Surface the AUTHORITATIVE org identity from the domain, and flag if
  // the self-declared org.name disagrees with it (display the verified one).
  const declaredName = persona.org.name;
  const nameMatches = !declaredName || !doc.name || String(declaredName) === String(doc.name);
  return {
    verified: true,
    reason: "valid",
    org: { did: v.did, name: doc.name || declaredName, url: doc.url },
    agent: v.agent,
    keyId: signedBy,
    nameMatches,
  };
}

// Convenience real-network resolver for the CLI (Node global fetch, >=18).
async function fetchResolver(url) {
  const res = await fetch(url, { redirect: "follow", headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

module.exports = {
  ORG_DOC_VERSION,
  WELL_KNOWN_FILE,
  didWebFromUrl,
  wellKnownUrlForDid,
  buildOrgDoc,
  attestationPayload,
  canonicalAttestationBytes,
  agentDidFromPersona,
  signOrgAttestation,
  verifyOrgAffiliation,
  fetchResolver,
};
