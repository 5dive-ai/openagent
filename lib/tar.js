"use strict";

// A small tar.gz reader and writer for agent bundles (lib/bundle.js), so the CLI
// keeps its zero-native-dependency install. Only what a bundle needs:
//
//   pack(entries, { mtime })  -> gzip Buffer. entries: [{ path, data: Buffer }],
//                               regular files only, written in the order given.
//                               ustar headers, uid/gid 0, mode 0644, one fixed
//                               mtime, so the same files give the same bytes.
//   unpack(gz, { maxFile, maxTotal }) -> [{ path, data }]
//                               reads ustar, GNU (`tar -czf`, which the 5dive
//                               CLI writes) and pax headers. Directories are
//                               skipped. A symlink, hardlink or device, an
//                               absolute path or one with a `..` segment is
//                               REFUSED, never skipped: a bundle that carries one
//                               was not written by an exporter.

const zlib = require("zlib");

const BLOCK = 512;

function octal(n, width) {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function header(name, size, mtime, prefix = "") {
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name, 0, 100, "utf8");
  h.write(octal(0o644, 8), 100, 8, "ascii");
  h.write(octal(0, 8), 108, 8, "ascii");
  h.write(octal(0, 8), 116, 8, "ascii");
  h.write(octal(size, 12), 124, 12, "ascii");
  h.write(octal(mtime, 12), 136, 12, "ascii");
  h.fill(" ", 148, 156);
  h.write("0", 156, 1, "ascii");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + " ", 148, 8, "ascii");
  return h;
}

// ustar splits a long path at a "/" into prefix (<=155 bytes) + name (<=100).
function splitPath(p) {
  if (Buffer.byteLength(p) <= 100) return { name: p, prefix: "" };
  for (let i = p.lastIndexOf("/"); i > 0; i = p.lastIndexOf("/", i - 1)) {
    const prefix = p.slice(0, i), name = p.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name) return { name, prefix };
  }
  throw new Error(`path too long for a bundle: ${p}`);
}

function pack(entries, { mtime = 0 } = {}) {
  const parts = [];
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const { name, prefix } = splitPath(e.path);
    parts.push(header(name, data.length, Math.max(0, Math.floor(mtime)), prefix), data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  // Node writes a gzip header with mtime 0 and no file name, so equal input
  // gives equal bytes.
  return zlib.gzipSync(Buffer.concat(parts), { level: 9 });
}

function cstr(buf, start, len) {
  const s = buf.subarray(start, start + len);
  const z = s.indexOf(0);
  return (z === -1 ? s : s.subarray(0, z)).toString("utf8");
}

function readSize(buf) {
  // GNU base-256 for sizes over 8 GB: never in a bundle, refuse it.
  if (buf[124] & 0x80) throw new Error("tar member too large");
  const s = cstr(buf, 124, 12).trim();
  return s ? parseInt(s, 8) : 0;
}

function checksumOk(h) {
  const want = parseInt(cstr(h, 148, 8).trim(), 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  return sum === want;
}

function parsePax(data) {
  const out = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) break;
    const len = parseInt(data.subarray(i, sp).toString("ascii"), 10);
    if (!len) break;
    const rec = data.subarray(sp + 1, i + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

// "./a/b" and "a/b" are the same member; "" and "." are the root itself.
function cleanPath(p) {
  let s = String(p).replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  s = s.replace(/\/+$/, "");
  if (s === "." || s === "") return "";
  if (s.startsWith("/")) throw new Error(`absolute path in bundle: ${p}`);
  if (s.split("/").some((seg) => seg === ".." || seg === "")) throw new Error(`unsafe path in bundle: ${p}`);
  return s;
}

function unpack(gz, { maxFile = 10 * 1024 * 1024, maxTotal = 64 * 1024 * 1024 } = {}) {
  // The inflate cap stops a gzip bomb before it is in memory.
  const buf = zlib.gunzipSync(gz, { maxOutputLength: maxTotal + 64 * 1024 * 1024 });
  const out = [];
  const seen = new Set();
  let total = 0, longName = null, pax = null;
  for (let off = 0; off + BLOCK <= buf.length; ) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    if (!checksumOk(h)) throw new Error("not a tar archive (bad header checksum)");
    const size = readSize(h);
    const type = String.fromCharCode(h[156] || 0x30);
    const dataStart = off + BLOCK;
    const data = buf.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "L") { longName = cstr(data, 0, data.length); continue; }
    if (type === "x") { pax = parsePax(data); continue; }
    if (type === "g") continue;
    let name = cstr(h, 0, 100);
    const magic = cstr(h, 257, 6);
    if (magic.startsWith("ustar")) {
      const prefix = cstr(h, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    if (pax && pax.path) name = pax.path;
    else if (longName) name = longName;
    longName = null; pax = null;
    const p = cleanPath(name);
    if (type === "5") continue;
    if (type !== "0" && type !== "\0" && type !== "7") {
      throw new Error(`bundle member ${p || name} is not a regular file (tar type '${type}')`);
    }
    if (!p) continue;
    if (seen.has(p)) throw new Error(`bundle carries ${p} twice`);
    seen.add(p);
    if (size > maxFile) throw new Error(`bundle member ${p} is over ${maxFile} bytes`);
    total += size;
    if (total > maxTotal) throw new Error(`bundle is over ${maxTotal} bytes unpacked`);
    out.push({ path: p, data: Buffer.from(data) });
  }
  return out;
}

module.exports = { pack, unpack, cleanPath };
