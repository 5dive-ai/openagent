"use strict";

// Per-agent keystore (DIVE-730) — the SINGLE source of truth for where an
// agent's signing identity lives, so the card path, `sign`, the A2A handshake
// (lib/handshake.js), and co-signed receipts (lib/receipts.js) all load the
// same key instead of each inventing a location.
//
// Layout (one identity per agent — on 5dive every agent is its own unix user,
// so one key per $HOME = one stable identity, provisioned invisibly):
//   ~/.openagent/agent.key      private ed25519 (pkcs8 PEM, mode 0600)
//   ~/.openagent/agent.pub      public  ed25519 (spki PEM) — convenience/cache
//   ~/.openagent/persona.yaml   the agent's signed self-card (written elsewhere)
//
// The home dir is the same one registry config already uses (~/.openagent/),
// overridable with OPENAGENT_HOME for tests / non-default deployments. Keys are
// generated and shaped by lib/provenance.js so every signature + did:key is
// byte-identical across card provenance, handshakes, and receipts.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { generateKeypair, publicPemFromPrivate, didKeyFromPublicKey } = require("./provenance");

// The openagent home directory. OPENAGENT_HOME wins (absolute or ~-relative);
// otherwise ~/.openagent — matching the registries.json config home.
function agentHome() {
  const env = process.env.OPENAGENT_HOME;
  if (env && env.trim()) {
    const e = env.trim();
    return e.startsWith("~") ? path.join(os.homedir(), e.slice(1)) : path.resolve(e);
  }
  return path.join(os.homedir(), ".openagent");
}

function agentKeyPath() { return path.join(agentHome(), "agent.key"); }
function agentPubPath() { return path.join(agentHome(), "agent.pub"); }
function agentPersonaPath() { return path.join(agentHome(), "persona.yaml"); }

// Derive the full keypair record from a private PEM (re-derives the public key
// + did:key so callers always get a consistent shape, even if agent.pub is
// stale or absent).
function recordFor(privateKey, source) {
  const publicKey = publicPemFromPrivate(privateKey);
  return { privateKey, publicKey, did: didKeyFromPublicKey(publicKey), path: agentKeyPath(), source };
}

// Load the agent's keystore key, or null if there is none yet. Never creates.
// Throws only if the file exists but is unreadable/corrupt.
function loadAgentKey() {
  const p = agentKeyPath();
  let privateKey;
  try {
    privateKey = fs.readFileSync(p, "utf8").trim();
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`keystore: cannot read ${p}: ${e.message}`);
  }
  if (!privateKey.includes("PRIVATE KEY")) {
    throw new Error(`keystore: ${p} is not a PEM private key`);
  }
  return recordFor(privateKey, "keystore");
}

// Load the agent's key, generating + persisting one on first use. This is the
// default identity source for auto-mint / sign / handshake / receipts: the
// first call provisions ~/.openagent/agent.key (0600) + agent.pub; every later
// call returns that same identity. Returns { privateKey, publicKey, did, path,
// source, created } where created=true only on the call that minted it.
function loadOrCreateAgentKey() {
  const existing = loadAgentKey();
  if (existing) return Object.assign(existing, { created: false });

  const home = agentHome();
  fs.mkdirSync(home, { recursive: true });
  const kp = generateKeypair();
  // 0600 so the secret is owner-only; write the public half too for quick reads.
  fs.writeFileSync(agentKeyPath(), kp.privateKey + "\n", { mode: 0o600 });
  try { fs.writeFileSync(agentPubPath(), kp.publicKey + "\n", { mode: 0o644 }); } catch (_) { /* pub is a convenience */ }
  return Object.assign(recordFor(kp.privateKey, "keystore"), { created: true });
}

module.exports = {
  agentHome,
  agentKeyPath,
  agentPubPath,
  agentPersonaPath,
  loadAgentKey,
  loadOrCreateAgentKey,
};
