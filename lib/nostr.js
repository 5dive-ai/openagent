"use strict";

// Nostr primitives OpenAgent needs to bind an agent identity to a Buzz identity
// (DIVE-3138, split from DIVE-2895). Two things live here and nothing else:
//
//   1. NIP-19 bech32 `npub` encode/decode.
//   2. BIP-340 x-only schnorr over secp256k1 (sign + verify).
//
// WHY THIS IS HAND-ROLLED RATHER THAN A DEPENDENCY. `@5dive/openagent` is a
// published CLI whose entire crypto surface is node's built-in `crypto` — it has
// four runtime deps and none of them are cryptographic. Adding a curve library
// to mint one attestation widens the supply chain of a signing tool, which is
// the last package where that trade is worth making. secp256k1 point arithmetic
// in BigInt is ~120 lines and is pinned here against the published BIP-340 and
// NIP-19 vectors (test/buzz.js). It is NOT constant-time; see the warning on
// schnorrSign().
//
// WHY NOTHING HERE DERIVES ONE IDENTITY FROM THE OTHER. Buzz identity is
// secp256k1 x-only BIP-340 (NIP-OA.md:37). OpenAgent identity is did:key over
// ed25519. There is no derivation between the curves in either direction, and
// NIP-OA.md:22 explicitly declines to define one. An agent therefore holds a
// SECOND, Buzz-local keypair, and the only artefact tying the two is the
// co-signed attestation in lib/buzz-identity.js.

const crypto = require("crypto");

// ---- bech32 (BIP-173) / NIP-19 ----------------------------------------------
//
// TRAP THIS ENCODER EXISTS TO AVOID (measured, DIVE-2895 / the Phase-0 review):
// a checksum wrong in only its last six characters still begins `npub1` and
// still has exactly the right length. Every shape assertion passes and the
// NIP-27 mention branch silently never matches. The 5-bit groups must be
// emitted as [...hi, ...lo] with the padding zero in the documented place — NOT
// interleaved per character. The only assertion that catches a miss here is a
// WHOLE-STRING comparison against the NIP-19 vector, which test/buzz.js does.

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function bech32Polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= BECH32_GENERATOR[i];
  }
  return chk;
}

function bech32HrpExpand(hrp) {
  const hi = [];
  const lo = [];
  for (let i = 0; i < hrp.length; i++) {
    const c = hrp.charCodeAt(i);
    hi.push(c >> 5);
    lo.push(c & 31);
  }
  return [...hi, 0, ...lo];
}

function bech32Checksum(hrp, data) {
  const values = [...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const polymod = bech32Polymod(values) ^ 1;
  const out = [];
  for (let i = 0; i < 6; i++) out.push((polymod >> (5 * (5 - i))) & 31);
  return out;
}

function bech32Encode(hrp, data) {
  const combined = [...data, ...bech32Checksum(hrp, data)];
  return hrp + "1" + combined.map((d) => BECH32_CHARSET[d]).join("");
}

function bech32Decode(str) {
  const s = String(str);
  if (s.length < 8 || s.length > 1024) return null;
  const lower = s.toLowerCase();
  if (s !== lower && s !== s.toUpperCase()) return null; // mixed case is invalid
  const pos = lower.lastIndexOf("1");
  if (pos < 1 || pos + 7 > lower.length) return null;
  const hrp = lower.slice(0, pos);
  const data = [];
  for (const ch of lower.slice(pos + 1)) {
    const v = BECH32_CHARSET.indexOf(ch);
    if (v === -1) return null;
    data.push(v);
  }
  if (bech32Polymod([...bech32HrpExpand(hrp), ...data]) !== 1) return null; // checksum
  return { hrp, data: data.slice(0, data.length - 6) };
}

function convertBits(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
    return null;
  }
  return out;
}

/** 64-char lowercase x-only hex -> `npub1…` (NIP-19). Throws on bad input. */
function npubEncode(hex) {
  const h = String(hex || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("npubEncode: need 64-char hex x-only pubkey");
  const words = convertBits([...Buffer.from(h, "hex")], 8, 5, true);
  if (!words) throw new Error("npubEncode: convertBits failed");
  return bech32Encode("npub", words);
}

/** `npub1…` -> 64-char lowercase hex, or null if malformed/bad checksum. */
function npubDecode(npub) {
  const d = bech32Decode(npub);
  if (!d || d.hrp !== "npub") return null;
  const bytes = convertBits(d.data, 5, 8, false);
  if (!bytes || bytes.length !== 32) return null;
  return Buffer.from(bytes).toString("hex");
}

// ---- secp256k1 / BIP-340 -----------------------------------------------------

const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

const mod = (a, m = P) => ((a % m) + m) % m;

function powMod(base, exp, m) {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

const invMod = (a, m = P) => powMod(a, m - 2n, m);

// Jacobian-free affine arithmetic: slower, far easier to audit. A binding is
// signed once per agent, not per event, so this is not on any hot path.
function pointAdd(p1, p2) {
  if (!p1) return p2;
  if (!p2) return p1;
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  if (x1 === x2 && y1 !== y2) return null; // P + (-P) = infinity
  const lam =
    x1 === x2 && y1 === y2
      ? mod(3n * x1 * x1 * invMod(2n * y1))
      : mod((y2 - y1) * invMod(mod(x2 - x1)));
  const x3 = mod(lam * lam - x1 - x2);
  return [x3, mod(lam * (x1 - x3) - y1)];
}

function pointMul(point, scalar) {
  let acc = null;
  let addend = point;
  let k = mod(scalar, N);
  while (k > 0n) {
    if (k & 1n) acc = pointAdd(acc, addend);
    addend = pointAdd(addend, addend);
    k >>= 1n;
  }
  return acc;
}

/** BIP-340 lift_x: the even-Y point with this x, or null if x is not on curve. */
function liftX(x) {
  if (x <= 0n || x >= P) return null;
  const ySq = mod(x * x * x + 7n);
  const y = powMod(ySq, (P + 1n) / 4n, P);
  if (mod(y * y) !== ySq) return null;
  return [x, (y & 1n) === 0n ? y : P - y];
}

const bytes32 = (n) => Buffer.from(n.toString(16).padStart(64, "0"), "hex");
const toBig = (buf) => BigInt("0x" + Buffer.from(buf).toString("hex"));

/** BIP-340 tagged hash: SHA256(SHA256(tag) || SHA256(tag) || msg). */
function taggedHash(tag, ...parts) {
  const th = crypto.createHash("sha256").update(tag, "utf8").digest();
  const h = crypto.createHash("sha256").update(th).update(th);
  for (const p of parts) h.update(p);
  return h.digest();
}

/** 32-byte secret key -> 32-byte x-only public key (hex in, hex out). */
function schnorrPublicKey(secretHex) {
  const d = toBig(Buffer.from(String(secretHex), "hex"));
  if (d <= 0n || d >= N) throw new Error("schnorrPublicKey: secret key out of range");
  const Pp = pointMul([GX, GY], d);
  return bytes32(Pp[0]).toString("hex");
}

/**
 * BIP-340 sign. `aux` is REQUIRED and must be 32 bytes.
 *
 * THE AUX TRAP (NIP-AE.md:250, carried into our constraints page): 32 zero bytes
 * is NOT the same as "aux omitted". libsecp256k1's NULL-extraparams path skips
 * the XOR entirely and produces a DIFFERENT — still valid — signature. Two
 * implementations that disagree here both verify and never reproduce each
 * other's vectors, so this parameter is mandatory rather than defaulted.
 * Production callers pass crypto.randomBytes(32); the BIP-340 vectors pass zeros.
 *
 * NOT CONSTANT-TIME. BigInt arithmetic leaks timing. Adequate for signing a
 * long-lived identity binding from a key held on our own host; do NOT reuse this
 * to sign per-event traffic under an adversary who can time it.
 */
function schnorrSign(msg32, secretHex, aux32) {
  const m = Buffer.from(msg32);
  if (m.length !== 32) throw new Error("schnorrSign: message must be exactly 32 bytes");
  const aux = Buffer.from(aux32 || []);
  if (aux.length !== 32) throw new Error("schnorrSign: aux must be exactly 32 bytes (zeros != omitted)");
  const d0 = toBig(Buffer.from(String(secretHex), "hex"));
  if (d0 <= 0n || d0 >= N) throw new Error("schnorrSign: secret key out of range");
  const Pp = pointMul([GX, GY], d0);
  const d = (Pp[1] & 1n) === 0n ? d0 : N - d0;
  const t = bytes32(d ^ toBig(taggedHash("BIP0340/aux", aux)));
  const rand = taggedHash("BIP0340/nonce", t, bytes32(Pp[0]), m);
  const k0 = mod(toBig(rand), N);
  if (k0 === 0n) throw new Error("schnorrSign: nonce was zero (retry with fresh aux)");
  const R = pointMul([GX, GY], k0);
  const k = (R[1] & 1n) === 0n ? k0 : N - k0;
  const e = mod(toBig(taggedHash("BIP0340/challenge", bytes32(R[0]), bytes32(Pp[0]), m)), N);
  return Buffer.concat([bytes32(R[0]), bytes32(mod(k + e * d, N))]).toString("hex");
}

/** BIP-340 verify. Never throws — malformed input is `false`, not an exception. */
function schnorrVerify(msg32, pubHex, sigHex) {
  try {
    const m = Buffer.from(msg32);
    if (m.length !== 32) return false;
    if (!/^[0-9a-fA-F]{64}$/.test(String(pubHex))) return false;
    if (!/^[0-9a-fA-F]{128}$/.test(String(sigHex))) return false;
    const Pp = liftX(BigInt("0x" + pubHex));
    if (!Pp) return false;
    const sig = Buffer.from(String(sigHex), "hex");
    const r = toBig(sig.subarray(0, 32));
    const s = toBig(sig.subarray(32, 64));
    if (r >= P || s >= N) return false;
    const e = mod(toBig(taggedHash("BIP0340/challenge", sig.subarray(0, 32), bytes32(Pp[0]), m)), N);
    // R = s*G - e*P
    const eP = pointMul(Pp, N - e);
    const R = pointAdd(pointMul([GX, GY], s), eP);
    if (!R) return false; // point at infinity
    if ((R[1] & 1n) !== 0n) return false; // R.y must be even
    return R[0] === r;
  } catch {
    return false;
  }
}

module.exports = {
  bech32Encode,
  bech32Decode,
  convertBits,
  npubEncode,
  npubDecode,
  taggedHash,
  schnorrPublicKey,
  schnorrSign,
  schnorrVerify,
};
