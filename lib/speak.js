"use strict";

// OpenAgent → Gemini TTS adapter (DIVE-662). Voices a persona: maps
// `voice.audio.base` (a named voice) to a Gemini prebuilt TTS voice and
// `voice.audio.style` to natural-language prompt steering, then synthesizes
// speech in that locked voice. CORE-SPEC ONLY — reads nothing but voice.audio;
// no registry / Mythical dependency.
//
// Note on fidelity: a persona's base is the UNDERLYING voice. If a character
// uses a fully CUSTOM cloned voice (voice.audio.ref / id), prebuilt TTS renders
// the base, an approximation — not the clone. Cloning needs a provider that
// supports it (not Gemini prebuilt TTS).

const fs = require("fs");
const YAML = require("yaml");

const DEFAULT_MODEL = process.env.OPENAGENT_TTS_MODEL || "gemini-2.5-flash-preview-tts";

// Gemini TTS returns raw little-endian PCM (24kHz, 16-bit, mono). Wrap in WAV.
function pcmToWav(pcm, { rate = 24000, bits = 16, channels = 1 } = {}) {
  const byteRate = (rate * channels * bits) / 8;
  const blockAlign = (channels * bits) / 8;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32); h.writeUInt16LE(bits, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Synthesize speech for a persona file. Returns { ok, outPath, voice, styled }
// or { error }. opts: { out, voice, model, text }.
async function speak(file, text, opts = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { error: "GEMINI_API_KEY not set" };
  let persona;
  try { persona = YAML.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { return { error: `could not read persona: ${e.message}` }; }

  const audio = (persona && persona.voice && persona.voice.audio) || {};
  // Vendor-neutral spec: voice.audio.provider names whose catalog `base` is from.
  // `speak` currently synthesizes via Gemini; flag a non-default provider so the
  // output isn't silently wrong (base is treated as a Gemini voice name here).
  const provider = String(audio.provider || "google-gemini").trim().toLowerCase();
  if (provider && provider !== "google-gemini") {
    process.stderr.write(
      `⚠ voice.audio.provider="${audio.provider}" — speak only synthesizes via google-gemini today; ` +
      `treating base "${opts.voice || audio.base}" as a Gemini voice (approximation).\n`
    );
  }
  const base = opts.voice || audio.base;
  if (!base || base === "unset") return { error: "persona has no named voice.audio.base (pass --voice to override)" };
  const style = String(audio.style || "").trim();

  // Style → prompt steering. A short directive prefix is how Gemini TTS keeps
  // voice.audio.style reproducible across renders.
  const prompt = style ? `Say the following in a ${style} tone:\n${text}` : text;
  const model = opts.model || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: base } } },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { error: `Gemini TTS HTTP ${res.status}: ${(await res.text()).slice(0, 180)}` };
  const data = await res.json();
  const part = data && data.candidates && data.candidates[0] &&
    data.candidates[0].content.parts.find((p) => p.inlineData && p.inlineData.data);
  if (!part) return { error: "no audio in response" };

  const pcm = Buffer.from(part.inlineData.data, "base64");
  const outPath = opts.out || file.replace(/\.(ya?ml|json)$/i, "") + ".wav";
  fs.writeFileSync(outPath, pcmToWav(pcm));
  return { ok: true, outPath, voice: base, styled: !!style, bytes: pcm.length, id: (persona && persona.id) || file };
}

module.exports = { speak, pcmToWav };
