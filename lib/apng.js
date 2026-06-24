"use strict";

// Dependency-free Animated PNG (APNG) assembler.
//
// resvg-js rasterizes each animation frame to a standard, full-size RGBA PNG.
// This stitches those identical-dimension PNGs into one looping APNG by parsing
// their chunks and re-emitting them as acTL / fcTL / fdAT — no native encoder,
// so `npx github:5dive-ai/openagent` keeps working with zero install.
//
// Frame 0 keeps its IDAT chunks verbatim (a vanilla PNG decoder shows it as the
// still card); frames 1..N ride in as fdAT. dispose=background, blend=source so
// every frame fully replaces the last (our frames are opaque full-card redraws).

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---- CRC32 (PNG polynomial) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Emit one PNG chunk: length, type, data, crc(type+data).
function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// Parse a PNG into its chunk list: [{ type, data }].
function parseChunks(png) {
  if (!png.slice(0, 8).equals(PNG_SIG)) throw new Error("not a PNG (bad signature)");
  const out = [];
  let off = 8;
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString("ascii", off + 4, off + 8);
    const data = png.slice(off + 8, off + 8 + len);
    out.push({ type, data });
    off += 12 + len;
    if (type === "IEND") break;
  }
  return out;
}

/**
 * Assemble an APNG buffer from an array of equal-dimension PNG frame buffers.
 * @param {Buffer[]} frames  PNG buffers (e.g. each from resvg .asPng())
 * @param {object}   opts    { delayNum, delayDen, plays }  delay = delayNum/delayDen seconds
 * @returns {Buffer} APNG
 */
function encodeApng(frames, opts = {}) {
  if (!Array.isArray(frames) || frames.length === 0) throw new Error("no frames");
  const delayNum = opts.delayNum != null ? opts.delayNum : 1;
  const delayDen = opts.delayDen != null ? opts.delayDen : 12;
  const plays = opts.plays != null ? opts.plays : 0; // 0 = loop forever

  const first = parseChunks(frames[0]);
  const ihdr = first.find((c) => c.type === "IHDR");
  if (!ihdr) throw new Error("frame 0 missing IHDR");
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);

  const parts = [PNG_SIG, chunk("IHDR", ihdr.data)];
  // Carry forward any palette/transparency chunks from frame 0.
  for (const c of first) if (c.type === "PLTE" || c.type === "tRNS") parts.push(chunk(c.type, c.data));

  // acTL — animation control.
  const acTL = Buffer.alloc(8);
  acTL.writeUInt32BE(frames.length, 0);
  acTL.writeUInt32BE(plays, 4);
  parts.push(chunk("acTL", acTL));

  let seq = 0;
  const fcTL = (w, h) => {
    const d = Buffer.alloc(26);
    d.writeUInt32BE(seq++, 0);
    d.writeUInt32BE(w, 4);
    d.writeUInt32BE(h, 8);
    d.writeUInt32BE(0, 12); // x_offset
    d.writeUInt32BE(0, 16); // y_offset
    d.writeUInt16BE(delayNum, 20);
    d.writeUInt16BE(delayDen, 22);
    d.writeUInt8(1, 24); // dispose_op = APNG_DISPOSE_OP_BACKGROUND
    d.writeUInt8(0, 25); // blend_op   = APNG_BLEND_OP_SOURCE
    return d;
  };

  for (let f = 0; f < frames.length; f++) {
    const chunks = f === 0 ? first : parseChunks(frames[f]);
    const idats = chunks.filter((c) => c.type === "IDAT").map((c) => c.data);
    if (idats.length === 0) throw new Error(`frame ${f} has no IDAT`);
    parts.push(chunk("fcTL", fcTL(width, height)));
    if (f === 0) {
      for (const d of idats) parts.push(chunk("IDAT", d));
    } else {
      for (const d of idats) {
        const fd = Buffer.alloc(4 + d.length);
        fd.writeUInt32BE(seq++, 0);
        d.copy(fd, 4);
        parts.push(chunk("fdAT", fd));
      }
    }
  }

  parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

module.exports = { encodeApng, crc32, parseChunks };
