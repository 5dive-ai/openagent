"use strict";

// OpenAgent → Flow/Veo adapter (DIVE-663). Turns a persona into a gen-video
// prompt that holds the cast face consistent across clips: maps `face.ref`
// (character reference image) + `face.recipe` (model/prompt/seed) + `face.anchor`
// (locked likeness) + `behavior` (demeanor) into a Flow/Veo-ready scene prompt.
// CORE-SPEC ONLY — reads face + behavior; no registry / Mythical dependency.
//
// The format is engine-neutral (Flow, Veo, Runway, Pika, Kling, Luma all take a
// reference image + a text prompt), so the same output drops into any of them.

const fs = require("fs");
const path = require("path");
const YAML = require("yaml");

// Resolve a persona-relative asset path (./avatar.png) against the file's dir,
// leaving URLs and absolute paths untouched — so the emitted reference points
// at a real file you can upload to the gen-video tool.
function resolveAsset(ref, baseDir) {
  if (!ref) return null;
  if (/^https?:\/\//.test(ref) || path.isAbsolute(ref)) return ref;
  return path.join(baseDir, ref);
}

// Build the Flow/Veo prompt + reference set for a persona shooting `scene`.
// Returns { ok, name, role, refs, model, seed, prompt } or { error }.
function flow(file, scene, opts = {}) {
  let persona;
  try { persona = YAML.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { return { error: `could not read persona: ${e.message}` }; }

  const face = (persona && persona.face) || {};
  if (!face.ref && !face.anchor) return { error: "persona has no face.ref / face.anchor to lock a likeness" };
  const baseDir = path.dirname(path.resolve(file));
  const recipe = face.recipe || {};
  const name = persona.name || persona.id || "the character";
  const role = persona.role ? ` — ${persona.role}` : "";

  const refs = [resolveAsset(face.ref, baseDir), resolveAsset(face.full, baseDir)].filter(Boolean);

  // Compose the scene prompt. Order matters: the action first (what the shot
  // is), then the hard likeness lock (anchor + recipe descriptors) so the face
  // stays on-model, then demeanor, then a consistency directive.
  const lines = [];
  lines.push(scene.trim());
  lines.push("");
  lines.push(`Character: ${name}${role}. The exact same person in every shot.`);
  if (face.anchor) lines.push(`Locked likeness: ${face.anchor}`);
  if (recipe.prompt) lines.push(`Appearance: ${recipe.prompt}`);
  if (persona.behavior) lines.push(`Demeanor: ${persona.behavior}`);
  lines.push("Render photoreal; keep face, hair, and wardrobe identical across all clips.");
  const prompt = lines.join("\n");

  return {
    ok: true,
    name,
    role: persona.role || null,
    refs,                       // upload these as the character reference
    model: recipe.model || null,
    seed: recipe.seed != null ? recipe.seed : null,
    prompt,
  };
}

module.exports = { flow };
