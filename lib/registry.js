"use strict";

// The official OpenAgent Mythical registry — ship + verify.
//
// Mythical is CONFERRED, not farmable: a persona is Mythical-eligible iff its
// id is listed in the official character-packs registry. That membership list
// must be trustworthy, so the CLI does not blindly trust whatever JSON happens
// to live at a URL — it verifies an ed25519 signature against a public key
// baked into this source file.
//
// Two layers, fail-closed:
//   1. SHIPPED  — a signed snapshot (registry/manifest.json + .sig) bundled in
//      the package. Always available, offline, pinned to the release. This is
//      the trust anchor: the curated Mythical set (currently reserved/empty).
//   2. FETCHED  — a live curated Mythical list, fetched at runtime for freshness.
//      Only trusted if it ships a valid signature (index.json.sig) over the same
//      key, AND only its explicit `slugs` array confers — a marketplace `packs[]`
//      listing is NOT Mythical (DIVE-674: marketplace membership != conferral).
//      Verified live slugs are UNIONED onto the shipped set (live can only ADD,
//      never revoke). If unsigned or the signature fails it is ignored and we
//      fall back to the shipped snapshot — so an unsigned/forged registry can
//      never confer Mythical.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Public half of the registry signing key. The private half is the registry
// signing secret, held by the maintainer — never in this repo. Swapping this
// constant or the bundled manifest both invalidate each other unless re-signed
// with that secret.
const REGISTRY_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA5wqhDCRCFPPDdgBfvOXxNx5M/S9RZwqrBP2voHewuBM=
-----END PUBLIC KEY-----
`;

const REGISTRY_DIR = path.join(__dirname, "..", "registry");
const MANIFEST_PATH = path.join(REGISTRY_DIR, "manifest.json");
const MANIFEST_SIG_PATH = path.join(REGISTRY_DIR, "manifest.sig");

const REGISTRY_URL =
  "https://raw.githubusercontent.com/5dive-ai/character-packs/main/index.json";
const REGISTRY_SIG_URL =
  "https://raw.githubusercontent.com/5dive-ai/character-packs/main/index.json.sig";

// Verify a detached ed25519 signature (base64) over `bytes` against our key.
function verifyBytes(bytes, sigB64) {
  try {
    return crypto.verify(null, bytes, REGISTRY_PUBLIC_KEY, Buffer.from(String(sigB64).trim(), "base64"));
  } catch (_) {
    return false;
  }
}

// The curated Mythical set is an EXPLICIT `slugs` list only (the signed bundled
// manifest, or a curated `slugs` array a live source opts into). We deliberately
// do NOT derive it from a marketplace index's `packs[]` (DIVE-674): being listed
// in character-packs is NOT the same as being conferred Mythical — conflating
// the two would force-promote every marketplace pack the moment a signed
// index.json.sig ships. A live source that wants to confer Mythical must publish
// a signed, curated `slugs` array, not lean on its pack listing.
function slugsOf(json) {
  if (!json || typeof json !== "object") return [];
  if (Array.isArray(json.slugs)) return json.slugs.filter((s) => typeof s === "string");
  return [];
}

// Load + verify the shipped snapshot. Fail-closed: a missing or tampered
// snapshot yields an empty, unverified set (no Mythical conferred) rather than
// trusting unverified bytes.
let _bundledCache = null;
function loadBundled() {
  if (_bundledCache) return _bundledCache;
  try {
    const bytes = fs.readFileSync(MANIFEST_PATH);
    const sig = fs.readFileSync(MANIFEST_SIG_PATH, "utf8");
    const verified = verifyBytes(bytes, sig);
    if (!verified) return (_bundledCache = { slugs: new Set(), verified: false, manifest: null });
    const manifest = JSON.parse(bytes.toString("utf8"));
    return (_bundledCache = { slugs: new Set(slugsOf(manifest)), verified: true, manifest });
  } catch (_) {
    return (_bundledCache = { slugs: new Set(), verified: false, manifest: null });
  }
}

// Fetch + verify the live registry. Returns a Set of slugs trusted live (empty
// if absent/unsigned/invalid). Best-effort, short timeout, never throws.
async function fetchLiveSlugs() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const [idxRes, sigRes] = await Promise.all([
      fetch(REGISTRY_URL, { signal: ctrl.signal }),
      fetch(REGISTRY_SIG_URL, { signal: ctrl.signal }).catch(() => null),
    ]);
    clearTimeout(t);
    if (!idxRes || !idxRes.ok || !sigRes || !sigRes.ok) return new Set();
    const bytes = Buffer.from(await idxRes.arrayBuffer());
    const sig = await sigRes.text();
    if (!verifyBytes(bytes, sig)) return new Set(); // unsigned/forged live → ignored
    return new Set(slugsOf(JSON.parse(bytes.toString("utf8"))));
  } catch (_) {
    return new Set();
  }
}

// The trusted Mythical-eligible id set: verified shipped snapshot UNION verified
// live slugs. `opts.offline` (or no global fetch) skips the network entirely.
let _idsCache = null;
async function fetchRegistryIds(opts = {}) {
  if (_idsCache) return _idsCache;
  const bundled = loadBundled();
  const ids = new Set(bundled.slugs);
  if (!opts.offline && typeof fetch === "function") {
    for (const s of await fetchLiveSlugs()) ids.add(s);
  }
  return (_idsCache = ids);
}

// Diagnostics for the `registry` command — does not hit the network unless asked.
async function registryStatus(opts = {}) {
  const bundled = loadBundled();
  const live = opts.offline || typeof fetch !== "function" ? new Set() : await fetchLiveSlugs();
  return {
    verified: bundled.verified,
    signedAt: bundled.manifest ? bundled.manifest.signedAt : null,
    snapshotOf: bundled.manifest ? bundled.manifest.snapshotOf : null,
    bundled: [...bundled.slugs],
    live: [...live],
    liveSigned: live.size > 0,
  };
}

// Test seam: reset memoized state.
function _reset() {
  _bundledCache = null;
  _idsCache = null;
}

module.exports = {
  fetchRegistryIds,
  registryStatus,
  loadBundled,
  verifyBytes,
  slugsOf,
  REGISTRY_PUBLIC_KEY,
  REGISTRY_URL,
  REGISTRY_SIG_URL,
  _reset,
};
