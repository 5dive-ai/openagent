"use strict";

// Character Card (Tavern card) interop tests — DIVE-1275.
const assert = require("assert");
const zlib = require("zlib");
const cc = require("../lib/charactercard");
const { validateDoc } = require("../lib/validate");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}: ${e.message}`);
  }
}

const persona = {
  openagent: "0.2",
  id: "lilbro",
  name: "Lil bro",
  role: "Creative Director",
  org: { name: "5dive", url: "https://5dive.ai" },
  behavior: "makes the memes, videos, scroll-stoppers.",
  posts_about: ["creative drops", "reels", "memes"],
  face: { ref: "https://example.com/lilbro.png", anchor: "youngest in the room" },
  voice: { written: { rules: ["lowercase, fragments, dry", "minimal words"], sample: "new reel. penguin escalates." } },
  links: { profile: "https://5dive.com/team", avatar: "https://example.com/lilbro.png" },
};

// 1. persona -> V3 card shape.
check("to-charactercard V3 wraps spec + data", () => {
  const card = cc.personaToCharacterCard(persona, { version: "v3" });
  assert.strictEqual(card.spec, "chara_card_v3");
  assert.strictEqual(card.spec_version, "3.0");
  assert.strictEqual(card.data.name, "Lil bro");
  assert.strictEqual(card.data.personality, "Creative Director");
  assert.strictEqual(card.data.first_mes, "new reel. penguin escalates.");
  assert.deepStrictEqual(card.data.tags, ["creative drops", "reels", "memes"]);
  assert.strictEqual(card.data.creator, "5dive");
  assert.ok(card.data.system_prompt.includes("Lil bro"), "system_prompt names the character");
  assert.ok(card.data.system_prompt.includes("lowercase, fragments"), "system_prompt carries voice rules");
  assert.ok(Array.isArray(card.data.assets) && card.data.assets[0].uri.includes("lilbro"), "v3 asset uses avatar");
});

// 2. persona -> V2 card shape (no v3-only fields).
check("to-charactercard V2 shape", () => {
  const card = cc.personaToCharacterCard(persona, { version: "v2" });
  assert.strictEqual(card.spec, "chara_card_v2");
  assert.strictEqual(card.spec_version, "2.0");
  assert.strictEqual(card.data.assets, undefined);
});

// 3. Lossless round-trip: persona -> card -> persona restores the original.
check("round-trip via extensions.openagent is lossless", () => {
  const card = cc.personaToCharacterCard(persona, { version: "v3" });
  const { persona: back, roundTripped } = cc.characterCardToPersona(card);
  assert.strictEqual(roundTripped, true);
  assert.deepStrictEqual(back, persona);
});

// 4. Synthesize a valid persona from a foreign (non-OpenAgent) card.
check("from-charactercard synthesizes a VALID persona", () => {
  const foreign = {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: "Seraphina",
      description: "A gentle forest guardian who heals wounded travelers.",
      personality: "warm, patient, wise",
      first_mes: "*She looks up from her herbs.* Oh! A visitor.",
      tags: ["fantasy", "healer"],
      creator: "someone",
      system_prompt: "You are Seraphina.",
    },
  };
  const { persona: p, roundTripped } = cc.characterCardToPersona(foreign);
  assert.strictEqual(roundTripped, false);
  assert.strictEqual(p.id, "seraphina");
  assert.strictEqual(p.name, "Seraphina");
  assert.strictEqual(p.role, "warm, patient, wise");
  assert.strictEqual(p.org.name, "someone");
  assert.ok(p.voice.written.sample.includes("visitor"));
  const chk = validateDoc(p);
  assert.ok(chk.ok, "synthesized persona validates: " + JSON.stringify(chk.errors));
});

// 5. Bare data (unwrapped) is accepted.
check("from-charactercard accepts bare data object", () => {
  const { persona: p } = cc.characterCardToPersona({ name: "Bare Char", description: "x" });
  assert.strictEqual(p.name, "Bare Char");
  assert.ok(validateDoc(p).ok);
});

// 6. PNG embed + extract round-trip (tEXt).
const MINIMAL_PNG = (() => {
  // 1x1 transparent PNG.
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
  );
})();

check("PNG embed + extract (chara + ccv3) round-trips", () => {
  assert.ok(cc.isPng(MINIMAL_PNG), "fixture is a PNG");
  const card = cc.personaToCharacterCard(persona, { version: "v3" });
  const png = cc.writeCharaToPng(MINIMAL_PNG, card);
  assert.ok(cc.isPng(png), "output is still a PNG");
  const read = cc.readCharaFromPng(png);
  assert.strictEqual(read.spec, "chara_card_v3");
  assert.strictEqual(read.data.name, "Lil bro");
  // Extracted card round-trips back to the original persona.
  const { persona: back } = cc.characterCardToPersona(read);
  assert.deepStrictEqual(back, persona);
});

// 7. Re-embedding replaces (never duplicates) the card chunk.
check("re-embed does not duplicate chara chunks", () => {
  const card1 = cc.personaToCharacterCard(persona, { version: "v2" });
  const once = cc.writeCharaToPng(MINIMAL_PNG, card1);
  const card2 = cc.personaToCharacterCard({ ...persona, name: "Changed" }, { version: "v2" });
  const twice = cc.writeCharaToPng(once, card2);
  const read = cc.readCharaFromPng(twice);
  assert.strictEqual(read.data.name, "Changed");
});

// 8. zTXt (compressed) extraction works. Build a guaranteed-valid PNG from
// scratch so chunk offsets are exact, then hand-assemble a zTXt `chara` chunk.
const CRC_T = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const tb = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb), 0);
  return Buffer.concat([len, tb, crc]);
}

check("reads zTXt-compressed chara chunk", () => {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0); ihdrData.writeUInt32BE(1, 4);
  ihdrData[8] = 8; ihdrData[9] = 0; // 8-bit grayscale
  const idat = chunk("IDAT", zlib.deflateSync(Buffer.from([0, 0]))); // one filtered scanline
  const card = cc.personaToCharacterCard(persona, { version: "v2" });
  const b64 = Buffer.from(JSON.stringify(card)).toString("base64");
  const compressed = zlib.deflateSync(Buffer.from(b64, "latin1"));
  // zTXt data: keyword \0 compressionMethod(0) compressedText
  const ztxtData = Buffer.concat([Buffer.from("chara", "latin1"), Buffer.from([0, 0]), compressed]);
  const ztxt = chunk("zTXt", ztxtData);
  const png = Buffer.concat([SIG, chunk("IHDR", ihdrData), idat, ztxt, chunk("IEND", Buffer.alloc(0))]);
  const read = cc.readCharaFromPng(png);
  assert.ok(read && read.data.name === "Lil bro", "zTXt card extracted");
});

console.log(failures === 0 ? "\nALL PASS (charactercard)" : `\n${failures} FAILURE(S) (charactercard)`);
process.exit(failures === 0 ? 0 : 1);
