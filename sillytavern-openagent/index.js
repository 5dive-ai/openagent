// OpenAgent Import — a SillyTavern 3rd-party extension (DIVE-1280).
//
// Brings the OpenAgent persona ecosystem into SillyTavern: paste (or upload) an
// OpenAgent persona OR a Character Card and this imports it as a ST character.
// Personas are converted in-browser using the SAME field map as the shipped
// `openagent card --to-charactercard` converter (@5dive/openagent v0.39.0, lib/
// charactercard.js), so the two paths produce identical cards.
//
// Wedge: unlike a static roleplay card, an OpenAgent persona can be backed by a
// LIVE agent that actually does work. The extension surfaces that CTA on import
// ("a character that actually does work"), converting "cute character" into
// "character with a real agent behind it".
//
// NOTE on the "live brain" path: pointing a roleplay host at a 5dive agent as an
// OpenAI-compatible backend is NOT supported — 5dive exposes no OpenAI-compat
// HTTP endpoint (verified DIVE-1281). The portable-persona (card) path below is
// the real distribution lever. The CTA links out to the live-agent product
// rather than proxying a chat completion.

const EXT_ID = "openagent-import";
const OPENAGENT_HOME = "https://openagent.5dive.ai";
const CCV2_SPEC = "chara_card_v2";
const CCV3_SPEC = "chara_card_v3";

// ── ST context (public extension API) ─────────────────────────────────────
function ctx() {
  // eslint-disable-next-line no-undef
  return typeof SillyTavern !== "undefined" && SillyTavern.getContext
    ? SillyTavern.getContext()
    : null;
}

// ── field-map helpers (mirror lib/charactercard.js) ───────────────────────
function slugify(s) {
  return (
    String(s || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "imported-character"
  );
}
function strArray(a) {
  if (!Array.isArray(a)) return [];
  return a.map((x) => String(x)).filter(Boolean);
}
function composeSystemPrompt(p) {
  const lines = [];
  const who = [p.name, p.role].filter(Boolean).join(", ");
  if (who) lines.push(`You are ${who}.`);
  if (p.behavior) lines.push(String(p.behavior).trim());
  const rules = strArray(p.voice && p.voice.written && p.voice.written.rules);
  if (rules.length) {
    lines.push("Voice and style:");
    for (const r of rules) lines.push(`- ${r}`);
  }
  return lines.join("\n").trim();
}

// persona -> Character Card. version: "v2" | "v3" (default v3, the superset).
function personaToCharacterCard(persona, version) {
  const p = persona || {};
  version = (version || "v3").toLowerCase();
  const avatar =
    (p.links && (p.links.avatar || p.links.profile)) ||
    (p.face && typeof p.face.ref === "string" && /^https?:\/\//.test(p.face.ref) ? p.face.ref : "") ||
    "";
  const creator =
    (p.org && p.org.name) ||
    (p.provenance && p.provenance.created_by && p.provenance.created_by.name) ||
    "";
  const sample = (p.voice && p.voice.written && p.voice.written.sample) || "";

  const data = {
    name: p.name || p.id || "Character",
    description: String(p.behavior || p.role || "").trim(),
    personality: String(p.role || "").trim(),
    scenario: "",
    first_mes: String(sample).trim(),
    mes_example: "",
    creator_notes:
      `OpenAgent persona "${p.id || slugify(p.name)}". ` +
      `Unlike a static roleplay card, this identity can be backed by a live agent that actually does work — see openagent.5dive.ai.`,
    system_prompt: composeSystemPrompt(p),
    post_history_instructions: "",
    alternate_greetings: [],
    tags: strArray(p.posts_about),
    creator: String(creator || "").trim(),
    character_version: String(p.openagent || "").trim(),
    extensions: { openagent: { spec: p.openagent || "0.2", persona: p } },
  };

  if (version === "v2") {
    return { spec: CCV2_SPEC, spec_version: "2.0", data };
  }
  data.nickname = "";
  data.group_only_greetings = [];
  data.creator_notes_multilingual = {};
  data.source = avatar && /^https?:\/\//.test(avatar) ? [avatar] : [];
  data.assets = avatar
    ? [{ type: "icon", uri: avatar, name: "main", ext: avatar.split(".").pop().split("?")[0].slice(0, 4) || "png" }]
    : [{ type: "icon", uri: "ccdefault:", name: "main", ext: "png" }];
  return { spec: CCV3_SPEC, spec_version: "3.0", data };
}

// ── tiny YAML-subset parser (block maps, sequences, scalars) ──────────────
// Sufficient for OpenAgent `*.persona.yaml` files (nested maps, string
// sequences, quoted/plain scalars, inline flow arrays, trailing comments).
// Not a general YAML implementation; if it can't parse, we tell the user to
// paste JSON or run the CLI converter. Indent-driven: a block's level is the
// actual indentation of its first entry, so arbitrary nesting works.
function stripComment(s) {
  // Remove a trailing "# comment" that's outside quotes (must follow space or
  // start the token), matching how the reference YAML parser treats comments.
  let inS = false,
    inD = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === "#" && !inS && !inD && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}
function parseYaml(src) {
  const lines = [];
  for (const ln of String(src).replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*#/.test(ln) || /^\s*$/.test(ln) || ln.trim() === "---" || ln.trim() === "...") continue;
    lines.push({ indent: ln.match(/^\s*/)[0].length, text: stripComment(ln).trim() });
  }
  let i = 0;
  function scalar(vRaw) {
    const v = String(vRaw).trim();
    if (v === "") return "";
    if (v === "true") return true;
    if (v === "false") return false;
    if (v === "null" || v === "~") return null;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    if (v[0] === "[" && v.endsWith("]")) return flowArray(v);
    if (v[0] === "{" && v.endsWith("}")) return flowMap(v);
    if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) {
      const body = v.slice(1, -1);
      return v[0] === '"' ? body.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\t/g, "\t") : body.replace(/''/g, "'");
    }
    return v;
  }
  function splitFlow(s) {
    const out = [];
    let depth = 0,
      inS = false,
      inD = false,
      cur = "";
    for (const c of s) {
      if (c === "'" && !inD) inS = !inS;
      else if (c === '"' && !inS) inD = !inD;
      if (!inS && !inD) {
        if (c === "[" || c === "{") depth++;
        else if (c === "]" || c === "}") depth--;
        else if (c === "," && depth === 0) {
          out.push(cur);
          cur = "";
          continue;
        }
      }
      cur += c;
    }
    if (cur.trim() !== "") out.push(cur);
    return out;
  }
  function flowArray(v) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlow(inner).map((x) => scalar(x));
  }
  function flowMap(v) {
    const inner = v.slice(1, -1).trim();
    const obj = {};
    if (!inner) return obj;
    for (const pair of splitFlow(inner)) {
      const idx = pair.indexOf(":");
      if (idx < 0) continue;
      obj[scalar(pair.slice(0, idx))] = scalar(pair.slice(idx + 1));
    }
    return obj;
  }
  // Parse the block whose entries sit at exactly `indent`.
  function parseBlock(indent) {
    if (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("- ")) {
      const arr = [];
      while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("- ")) {
        const rest = lines[i].text.slice(2).trim();
        i++;
        if (rest === "") {
          arr.push(i < lines.length && lines[i].indent > indent ? parseBlock(lines[i].indent) : "");
        } else if (/^[\w.$-]+:(\s|$)/.test(rest)) {
          // "- key: value" — an inline map item; re-seed it one level deeper
          lines.splice(i, 0, { indent: indent + 2, text: rest });
          arr.push(parseBlock(indent + 2));
        } else {
          arr.push(scalar(rest));
        }
      }
      return arr;
    }
    const obj = {};
    while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith("- ")) {
      const m = lines[i].text.match(/^([^:]+):(?:\s+(.*))?$/);
      if (!m) break;
      const key = scalar(m[1]);
      const inline = m[2];
      i++;
      const block = inline !== undefined ? inline.match(/^([|>])([+-]?)\s*$/) : null;
      if (block) {
        // Literal (|) / folded (>) block scalar with optional chomp (-/+).
        const body = [];
        while (i < lines.length && lines[i].indent > indent) {
          body.push(lines[i].text);
          i++;
        }
        let val = block[1] === "|" ? body.join("\n") : body.join(" ");
        if (block[2] === "-") val = val.replace(/\n+$/, "");
        else if (block[2] === "+") val += "\n";
        else val = val.replace(/\n+$/, "") + "\n";
        obj[key] = val;
      } else if (inline !== undefined && inline !== "") {
        // Fold a plain multi-line scalar: unquoted, non-flow continuations that
        // sit deeper and aren't themselves a key/seq entry join with a space.
        const q = inline[0];
        let val = inline;
        if (q !== '"' && q !== "'" && q !== "[" && q !== "{") {
          while (
            i < lines.length &&
            lines[i].indent > indent &&
            !lines[i].text.startsWith("- ") &&
            !/^[^:]+:(\s|$)/.test(lines[i].text)
          ) {
            val += " " + lines[i].text;
            i++;
          }
        }
        obj[key] = scalar(val);
      } else if (i < lines.length && lines[i].indent > indent) {
        obj[key] = parseBlock(lines[i].indent);
      } else {
        obj[key] = "";
      }
    }
    return obj;
  }
  return i < lines.length ? parseBlock(lines[0].indent) : {};
}

// Parse persona/card text as JSON first, then YAML.
function parseInput(text) {
  const t = String(text || "").trim();
  if (!t) throw new Error("empty input");
  try {
    return JSON.parse(t);
  } catch (_) {
    /* fall through to YAML */
  }
  const y = parseYaml(t);
  if (!y || typeof y !== "object" || Array.isArray(y)) {
    throw new Error("could not parse input as JSON or YAML");
  }
  return y;
}

// Decide whether the parsed object is a persona or an already-built card, and
// return a Character Card (V2 or V3) ready to import.
function toCard(obj, version) {
  if (obj && (obj.spec === CCV2_SPEC || obj.spec === CCV3_SPEC) && obj.data) {
    return obj; // already a wrapped card
  }
  if (obj && obj.openagent) {
    return personaToCharacterCard(obj, version); // OpenAgent persona
  }
  // bare `data` object (some hosts export unwrapped) — wrap it
  if (obj && (obj.name || obj.first_mes || obj.description)) {
    return { spec: version === "v2" ? CCV2_SPEC : CCV3_SPEC, spec_version: version === "v2" ? "2.0" : "3.0", data: obj };
  }
  throw new Error("input is neither an OpenAgent persona nor a Character Card");
}

// ── import into SillyTavern ───────────────────────────────────────────────
async function importCard(card) {
  const context = ctx();
  if (!context || typeof context.getRequestHeaders !== "function") {
    throw new Error("SillyTavern context unavailable (open this from inside SillyTavern)");
  }
  const name = (card.data && card.data.name) || "Imported Character";
  const json = JSON.stringify(card);
  const file = new File([json], `${slugify(name)}.json`, { type: "application/json" });

  const form = new FormData();
  form.append("avatar", file);
  form.append("file_type", "json");

  // getRequestHeaders() includes CSRF; strip Content-Type so the browser sets
  // the multipart boundary itself.
  const headers = { ...context.getRequestHeaders() };
  delete headers["Content-Type"];
  delete headers["content-type"];

  const res = await fetch("/api/characters/import", { method: "POST", headers, body: form });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`import failed (${res.status}) ${body.slice(0, 160)}`);
  }
  // Refresh the character list if the API exposes it.
  try {
    if (typeof context.getCharacters === "function") await context.getCharacters();
  } catch (_) {
    /* non-fatal — user can refresh manually */
  }
  return name;
}

// ── UI ────────────────────────────────────────────────────────────────────
function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function openDialog() {
  if (document.getElementById(`${EXT_ID}-overlay`)) return;
  const overlay = el(`
    <div id="${EXT_ID}-overlay" class="oai-overlay">
      <div class="oai-modal">
        <div class="oai-head">
          <span>⚡ Import from OpenAgent</span>
          <span class="oai-x" title="Close">×</span>
        </div>
        <p class="oai-sub">Paste an OpenAgent <b>persona</b> (YAML or JSON) or a <b>Character Card</b>. It's converted and imported as a SillyTavern character. <a href="${OPENAGENT_HOME}" target="_blank" rel="noopener">What's OpenAgent?</a></p>
        <textarea id="${EXT_ID}-text" class="oai-text" placeholder="openagent: 0.2&#10;id: ada&#10;name: Ada&#10;role: research copilot&#10;..."></textarea>
        <div class="oai-row">
          <label class="oai-file">Load file… <input id="${EXT_ID}-file" type="file" accept=".yaml,.yml,.json" hidden></label>
          <label class="oai-ver">Card version
            <select id="${EXT_ID}-ver"><option value="v3">V3</option><option value="v2">V2</option></select>
          </label>
          <span class="oai-flex"></span>
          <button id="${EXT_ID}-go" class="oai-btn">Convert &amp; import</button>
        </div>
        <div id="${EXT_ID}-status" class="oai-status"></div>
        <div class="oai-wedge">💼 <b>A character that actually does work.</b> An OpenAgent persona can be backed by a live agent that runs real tasks on your own box — not just a chat costume. <a href="${OPENAGENT_HOME}" target="_blank" rel="noopener">Give this character a real agent →</a></div>
      </div>
    </div>`);
  document.body.appendChild(overlay);

  const $ = (id) => document.getElementById(`${EXT_ID}-${id}`);
  const status = $("status");
  const setStatus = (msg, kind) => {
    status.textContent = msg;
    status.className = "oai-status" + (kind ? " oai-" + kind : "");
  };
  const close = () => overlay.remove();
  overlay.querySelector(".oai-x").addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  $("file").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    $("text").value = await f.text();
    setStatus(`Loaded ${f.name}`, "ok");
  });

  $("go").addEventListener("click", async () => {
    setStatus("Converting…");
    try {
      const obj = parseInput($("text").value);
      const card = toCard(obj, $("ver").value);
      const name = await importCard(card);
      const roundTrips = !!(obj && obj.openagent);
      setStatus(`Imported "${name}" ✓${roundTrips ? "  (persona stashed in extensions for lossless round-trip)" : ""}`, "ok");
    } catch (err) {
      setStatus(`✗ ${err.message}. Tip: run \`openagent card --to-charactercard\` and paste the result, or paste persona JSON.`, "err");
    }
  });
}

// ── register the launcher button in the wand / extensions menu ─────────────
function mountButton() {
  const menu = document.getElementById("extensionsMenu");
  if (menu && !document.getElementById(`${EXT_ID}-launch`)) {
    const item = el(`
      <div id="${EXT_ID}-launch" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
        <div class="fa-solid fa-bolt extensionsMenuExtensionButton" title="Import from OpenAgent"></div>
        <span>Import from OpenAgent</span>
      </div>`);
    item.addEventListener("click", openDialog);
    menu.appendChild(item);
    return true;
  }
  return false;
}

// The extensions menu is built after ST boot; poll briefly, then also expose a
// floating fallback so the feature is reachable regardless of ST version.
(function init() {
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    if (mountButton() || tries > 40) clearInterval(timer);
  }, 500);

  if (!document.getElementById(`${EXT_ID}-fab`)) {
    const fab = el(`<div id="${EXT_ID}-fab" title="Import from OpenAgent">⚡</div>`);
    fab.addEventListener("click", openDialog);
    document.body.appendChild(fab);
  }
})();
