"use strict";

// OpenAgent Mythical registries — ship + verify, now FEDERATED (DIVE-689).
//
// Mythical is CONFERRED, not farmable: a persona is Mythical-eligible iff its
// id is listed in a TRUSTED signed registry. Originally there was exactly one
// trust anchor — the 5dive character-packs registry. That made OpenAgent a
// 5dive-only thing. It no longer is: anyone can run their own signed registry,
// and the CLI will trust it AS LONG AS its index is signed by a key the operator
// has explicitly added. Membership in any one trusted registry confers Mythical.
//
// Trust model — fail-closed, per-source:
//   * Each registry source declares its OWN public key. Its live index.json is
//     only trusted if index.json.sig verifies against THAT source's key. A
//     source can never confer for another source's key.
//   * The 5dive source is the built-in trust anchor: its key is baked into this
//     file and a signed snapshot (registry/manifest.json + .sig) ships in the
//     package so it works offline and pinned to the release.
//   * Operators add federated sources via (highest precedence last):
//       1. config file  ~/.openagent/registries.json  ({ "registries": [...] })
//       2. env          OPENAGENT_REGISTRIES  (inline JSON array, or a path to
//                        a JSON file/`{registries:[...]}` object)
//       3. flag         --registry name=URL[,key=PEM|@path][,sig=URL]  (repeatable)
//     Each entry: { name, url, sigUrl?, publicKey? | publicKeyPath? }. sigUrl
//     defaults to url + ".sig". A source with no usable key is dropped (can't
//     verify → can't confer).
//   * Verified slugs from every trusted source are UNIONED — sources can only
//     ADD eligibility, never revoke another's. An unsigned/forged/mis-keyed
//     source is ignored; we fall back to whatever the trust anchor already
//     conferred. So no unsigned registry can ever confer Mythical.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Public half of the 5dive registry signing key (built-in trust anchor). The
// private half is held by the maintainer — never in this repo. Swapping this
// constant or the bundled manifest both invalidate each other unless re-signed.
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

// The canonical built-in 5dive source. `name` is reserved; a federated source
// may not reuse it (we drop dupes by name, anchor wins).
const OFFICIAL_SOURCE = {
  name: "5dive",
  url: REGISTRY_URL,
  sigUrl: REGISTRY_SIG_URL,
  publicKey: REGISTRY_PUBLIC_KEY,
  official: true,
};

const CONFIG_PATH = path.join(os.homedir(), ".openagent", "registries.json");

// Verify a detached ed25519 signature (base64) over `bytes` against a PEM key.
function verifyBytes(bytes, sigB64, pubKey = REGISTRY_PUBLIC_KEY) {
  try {
    return crypto.verify(null, bytes, pubKey, Buffer.from(String(sigB64).trim(), "base64"));
  } catch (_) {
    return false;
  }
}

// The curated Mythical set is an EXPLICIT `slugs` list only (the signed bundled
// manifest, or a curated `slugs` array a live source opts into). We deliberately
// do NOT derive it from a marketplace index's `packs[]` (DIVE-674): being listed
// in a marketplace is NOT the same as being conferred Mythical.
function slugsOf(json) {
  if (!json || typeof json !== "object") return [];
  if (Array.isArray(json.slugs)) return json.slugs.filter((s) => typeof s === "string");
  return [];
}

// --- federated source discovery -------------------------------------------

// Resolve a source's public key: inline `publicKey`, or `publicKeyPath` read
// from disk (~ expanded). Returns the PEM string or null if unusable.
function resolveKey(src) {
  if (typeof src.publicKey === "string" && src.publicKey.includes("BEGIN PUBLIC KEY")) {
    return src.publicKey;
  }
  const p = src.publicKeyPath || src.keyPath;
  if (typeof p === "string" && p) {
    try {
      const expanded = p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
      const pem = fs.readFileSync(expanded, "utf8");
      if (pem.includes("BEGIN PUBLIC KEY")) return pem;
    } catch (_) {}
  }
  return null;
}

// Normalize a raw source object into {name,url,sigUrl,publicKey} or null.
function normalizeSource(raw) {
  if (!raw || typeof raw !== "object") return null;
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : url;
  if (!/^https?:\/\//.test(url)) return null;
  const key = resolveKey(raw);
  if (!key) return null; // no verifiable key → cannot confer → drop
  const sigUrl =
    typeof raw.sigUrl === "string" && raw.sigUrl.trim() ? raw.sigUrl.trim() : url + ".sig";
  return { name, url, sigUrl, publicKey: key };
}

// Parse OPENAGENT_REGISTRIES: a path to a JSON file, OR inline JSON (an array
// of sources, or a {registries:[...]} object).
function parseEnvSources(val) {
  if (!val || typeof val !== "string") return [];
  let text = val.trim();
  if (!text) return [];
  if (!text.startsWith("[") && !text.startsWith("{")) {
    // treat as a file path
    try {
      const expanded = text.startsWith("~") ? path.join(os.homedir(), text.slice(1)) : text;
      text = fs.readFileSync(expanded, "utf8");
    } catch (_) {
      return [];
    }
  }
  try {
    const json = JSON.parse(text);
    return Array.isArray(json) ? json : Array.isArray(json.registries) ? json.registries : [];
  } catch (_) {
    return [];
  }
}

// Parse repeatable `--registry name=acme,url=...,key=@/path/to.pub,sig=...`
// (or key=<inline-PEM>). Returns raw source objects.
function parseFlagSources(flags) {
  const out = [];
  for (const spec of flags || []) {
    const src = {};
    for (const part of String(spec).split(",")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      if (k === "name") src.name = v;
      else if (k === "url") src.url = v;
      else if (k === "sig" || k === "sigUrl") src.sigUrl = v;
      else if (k === "key" || k === "publicKey") {
        if (v.startsWith("@")) src.publicKeyPath = v.slice(1);
        else src.publicKey = v.replace(/\\n/g, "\n");
      } else if (k === "keyPath" || k === "publicKeyPath") src.publicKeyPath = v;
    }
    out.push(src);
  }
  return out;
}

// Read the config file's `registries` array (best-effort).
function readConfigSources() {
  try {
    const json = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return Array.isArray(json.registries) ? json.registries : [];
  } catch (_) {
    return [];
  }
}

// The full ordered trusted-source list: built-in anchor first, then federated
// (config → env → flags). Deduped by name; the anchor and earliest-seen win,
// so a federated source can never shadow the 5dive anchor.
function trustedSources(opts = {}) {
  const raw = [
    ...readConfigSources(),
    ...parseEnvSources(process.env.OPENAGENT_REGISTRIES),
    ...parseFlagSources(opts.registryFlags),
  ];
  const sources = [OFFICIAL_SOURCE];
  const seen = new Set([OFFICIAL_SOURCE.name]);
  for (const r of raw) {
    const s = normalizeSource(r);
    if (!s || seen.has(s.name)) continue;
    seen.add(s.name);
    sources.push(s);
  }
  return sources;
}

// --- snapshot + live verification -----------------------------------------

// Load + verify the shipped 5dive snapshot. Fail-closed: a missing or tampered
// snapshot yields an empty, unverified set (no Mythical conferred).
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

// Fetch + verify one source's live index against ITS OWN key. Returns
// { name, slugs:Set, signed:bool, reachable:bool }. Best-effort, never throws.
async function fetchSourceLive(src) {
  const res = { name: src.name, official: !!src.official, slugs: new Set(), signed: false, reachable: false };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const [idxRes, sigRes] = await Promise.all([
      fetch(src.url, { signal: ctrl.signal }),
      fetch(src.sigUrl, { signal: ctrl.signal }).catch(() => null),
    ]);
    clearTimeout(t);
    if (!idxRes || !idxRes.ok) return res;
    res.reachable = true;
    if (!sigRes || !sigRes.ok) return res; // unsigned → ignored
    const bytes = Buffer.from(await idxRes.arrayBuffer());
    const sig = await sigRes.text();
    if (!verifyBytes(bytes, sig, src.publicKey)) return res; // forged/mis-keyed → ignored
    res.signed = true;
    res.slugs = new Set(slugsOf(JSON.parse(bytes.toString("utf8"))));
    return res;
  } catch (_) {
    return res;
  }
}

// Back-compat: verified live slugs from the official 5dive source only.
async function fetchLiveSlugs() {
  return (await fetchSourceLive(OFFICIAL_SOURCE)).slugs;
}

// The trusted Mythical-eligible id set: verified shipped snapshot UNION verified
// live slugs from EVERY trusted source. `opts.offline` (or no global fetch)
// skips the network; `opts.registryFlags` injects `--registry` sources.
let _idsCache = null;
let _idsCacheKey = null;
async function fetchRegistryIds(opts = {}) {
  const key = JSON.stringify(opts.registryFlags || []) + (opts.offline ? "|off" : "");
  if (_idsCache && _idsCacheKey === key) return _idsCache;
  const bundled = loadBundled();
  const ids = new Set(bundled.slugs);
  if (!opts.offline && typeof fetch === "function") {
    const sources = trustedSources(opts);
    const results = await Promise.all(sources.map(fetchSourceLive));
    for (const r of results) for (const s of r.slugs) ids.add(s);
  }
  _idsCacheKey = key;
  return (_idsCache = ids);
}

// --- handle → pack resolution (DIVE-723) -----------------------------------

// Resolve a registry handle/slug (e.g. "olivia") to its pack location across the
// trusted sources, so `card --handle <name>` can render the OFFICIAL signed card
// instead of a re-minted working copy. We fetch each source's live index.json
// (over HTTPS from the hardcoded trust-anchor URL, plus any federated sources)
// and look up the pack by slug. Identity integrity does NOT rest on the index
// signature here — it rests on (a) the hardcoded HTTPS anchor URL, (b) the
// persona file's own provenance/did:key, and (c) the bundled-manifest registry
// check the renderer already runs (which confers tier/Mythical). The official
// live index currently ships no detached .sig, so requiring one would block every
// render; federated sources are still verified the usual way during tier checks.
//
// Returns { found, slug, sourceName, official, baseUrl, pack, available } —
// baseUrl is the directory the index.json lives in (so persona/avatar URLs are
// baseUrl + pack.path + "/<file>"). `available` lists known slugs on miss.
async function resolveHandle(slug, opts = {}) {
  const want = String(slug || "").trim().toLowerCase();
  if (!want) return { found: false, slug: want, available: [] };
  if (typeof fetch !== "function") {
    return { found: false, slug: want, available: [], error: "fetch unavailable (Node <18?)" };
  }
  const sources = trustedSources(opts);
  const available = new Set();
  for (const src of sources) {
    let json;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(src.url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res || !res.ok) continue;
      json = JSON.parse(await res.text());
    } catch (_) {
      continue;
    }
    const packs = Array.isArray(json && json.packs) ? json.packs : [];
    for (const p of packs) if (p && typeof p.slug === "string") available.add(p.slug);
    const pack = packs.find((p) => p && String(p.slug).toLowerCase() === want);
    if (pack) {
      const baseUrl = src.url.replace(/[^/]*$/, ""); // strip "index.json"
      return { found: true, slug: want, sourceName: src.name, official: !!src.official, baseUrl, pack };
    }
  }
  return { found: false, slug: want, available: [...available].sort() };
}

// Diagnostics for the `registry` command — does not hit the network unless asked.
async function registryStatus(opts = {}) {
  const bundled = loadBundled();
  const sources = trustedSources(opts);
  let live;
  if (!opts.offline && typeof fetch === "function") {
    live = await Promise.all(sources.map(fetchSourceLive));
  } else {
    live = sources.map((s) => ({ name: s.name, official: !!s.official, slugs: new Set(), signed: false, reachable: false }));
  }
  // Official live slugs surfaced flat for back-compat with prior callers.
  const official = live.find((r) => r.official) || { slugs: new Set() };
  return {
    verified: bundled.verified,
    signedAt: bundled.manifest ? bundled.manifest.signedAt : null,
    snapshotOf: bundled.manifest ? bundled.manifest.snapshotOf : null,
    bundled: [...bundled.slugs],
    live: [...official.slugs],
    liveSigned: official.slugs.size > 0,
    // Federated view: one entry per trusted source.
    sources: live.map((r) => ({
      name: r.name,
      official: r.official,
      signed: r.signed,
      reachable: r.reachable,
      slugs: [...r.slugs],
    })),
  };
}

// Test seam: reset memoized state.
function _reset() {
  _bundledCache = null;
  _idsCache = null;
  _idsCacheKey = null;
}

module.exports = {
  fetchRegistryIds,
  resolveHandle,
  registryStatus,
  loadBundled,
  fetchLiveSlugs,
  verifyBytes,
  slugsOf,
  trustedSources,
  normalizeSource,
  fetchSourceLive,
  REGISTRY_PUBLIC_KEY,
  REGISTRY_URL,
  REGISTRY_SIG_URL,
  OFFICIAL_SOURCE,
  CONFIG_PATH,
  _reset,
};
