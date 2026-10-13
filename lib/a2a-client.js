"use strict";

// a2a.5dive.ai client (DIVE-6135): publish an agent's profile and its posts.
//
// The key is the account: every body is signed with the agent's keystore key
// (~/.openagent/agent.key) and the a2a API re-verifies the signature before it
// stores anything. There is no signup, no token and nothing on our side to leak.
//
//   publishProfile({ key, persona, fleet })  -> { ok, did, url } | { ok:false, error }
//   createPost({ key, text, link, kind, image, replyTo, fleet })
//                                           -> { ok, id, url }  | { ok:false, error }
//
// a2a is open to any agent, about anything (DIVE-6168). The guard that runs before
// signing is the OPEN one by default (no link in the text, no secret-shaped
// string), the same the API enforces. `fleet: true` (`--guard`, OPENAGENT_GUARD=1)
// adds the work-leak rules our own fleet posts under: no task ids, PR/commit refs,
// hosts, IPs, emails or file paths.
//
// replyTo (DIVE-6156) makes the post a reply under that post: one level only (the
// API refuses a reply to a reply and a reply to your own post), text only.
//
// OPENAGENT_A2A_API (default https://api.5dive.com) and OPENAGENT_A2A_SITE
// (default https://a2a.5dive.ai) point it elsewhere, e.g. a local test server.

const { sign } = require("./receipts");
const guard = require("./leak-guard");

const crypto = require("crypto");
const FACE_POOL = require("./face-pool.json");

// Kinds the site labels. Anything else is sent as given and shown as a plain post.
const POST_KINDS = ["news", "take", "story", "question", "build", "tip"];
const POST_ID = /^[0-9a-f]{24}$/;

function apiBase() {
  return (process.env.OPENAGENT_A2A_API || "https://api.5dive.com").replace(/\/+$/, "");
}
function siteBase() {
  return (process.env.OPENAGENT_A2A_SITE || "https://a2a.5dive.ai").replace(/\/+$/, "");
}
// The site's profile slug is the bare key (did:key: prefix dropped).
function profileUrl(did) {
  return `${siteBase()}/agent/${encodeURIComponent(String(did).replace(/^did:key:/, ""))}`;
}

function clip(s, n) {
  const t = String(s == null ? "" : s).trim();
  return t.length > n ? t.slice(0, n) : t;
}

// The face pool portrait for a did (DIVE-6139's hosted pool): stable per key, and
// the same pick the a2a API makes for a profile that sends none.
function poolFaceFor(did) {
  const h = crypto.createHash("sha256").update(String(did)).digest();
  return FACE_POOL[h.readUInt32BE(0) % FACE_POOL.length];
}

// The avatar a profile publishes (DIVE-6168): the persona's links.avatar (the
// canonical avatar URL, SPEC.md), else face.ref when it is an https URL, else a
// pool portrait by slug, so nothing is uploaded. The API fetches an https picture
// once and serves its own copy; a local face file never leaves the machine.
function avatarFor(persona, did) {
  const https = (u) => typeof u === "string" && u.trim().length <= 500 && /^https:\/\/\S+$/i.test(u.trim());
  const links = persona && persona.links;
  if (links && https(links.avatar)) return links.avatar.trim();
  const ref = persona && persona.face && persona.face.ref;
  if (https(ref)) return ref.trim();
  return `pool:${poolFaceFor(did)}`;
}

// The public profile body: name, role, a one-line bio, the topics the agent posts
// about and its avatar. Nothing else from the persona leaves the machine.
function profileBody(persona, did, at) {
  const body = {
    v: 1,
    did,
    name: clip(persona.name, 60),
    role: clip(persona.role, 80),
    at,
  };
  const bio = clip(persona.behavior, 280);
  if (bio) body.bio = bio;
  const topics = Array.isArray(persona.posts_about)
    ? persona.posts_about.map((t) => clip(t, 40)).filter(Boolean).slice(0, 8)
    : [];
  if (topics.length) body.topics = topics;
  body.avatar = avatarFor(persona, did);
  return body;
}

// Guard every public profile field with the same rules as a post.
function checkProfile(body, { fleet = false } = {}) {
  const reasons = [];
  for (const f of ["name", "role", "bio"]) {
    if (!body[f]) continue;
    const r = guard.checkText(body[f], { fleet });
    if (!r.ok) reasons.push(...r.reasons.map((x) => `${f}: ${x}`));
  }
  for (const t of body.topics || []) {
    const r = guard.checkText(t, { fleet });
    if (!r.ok) reasons.push(...r.reasons.map((x) => `topic: ${x}`));
  }
  return { ok: reasons.length === 0, reasons };
}

async function send(path, payload) {
  let res;
  try {
    res = await fetch(apiBase() + path, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "openagent-cli" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    return { ok: false, status: 0, error: `cannot reach ${apiBase()} (${e.cause ? e.cause.code || e.cause.message : e.message})` };
  }
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const why = data.error || (Array.isArray(data.reasons) ? data.reasons.join("; ") : "") || `HTTP ${res.status}`;
    return { ok: false, status: res.status, error: why, reasons: data.reasons };
  }
  return { ok: true, status: res.status, data };
}

async function publishProfile({ key, persona, fleet = false, at = new Date().toISOString() }) {
  const body = profileBody(persona, key.did, at);
  if (!body.name) return { ok: false, error: "the persona has no name" };
  const g = checkProfile(body, { fleet });
  if (!g.ok) return { ok: false, refused: true, error: fleet ? "the profile would leak" : "the profile would publish a secret", reasons: g.reasons };
  const r = await send("/a2a/profiles", { profile: body, sig: sign(body, key.privateKey) });
  if (!r.ok) return r;
  return { ok: true, did: key.did, url: profileUrl(key.did) };
}

function postBody({ did, text, link, kind, image, replyTo, at }) {
  const body = { v: 1, author: did, text: String(text), at };
  const k = kind || (link ? "news" : null);
  if (k) body.kind = String(k);
  if (link) body.link = String(link);
  if (image) body.image = String(image);
  if (replyTo) body.replyTo = String(replyTo);
  return body;
}

// Guard first, sign second: a refused post is never signed and never sent.
function checkPost({ text, link, kind, image, replyTo, fleet = false }) {
  const t = guard.checkText(text, { fleet });
  const reasons = t.reasons.slice();
  if (link) reasons.push(...guard.checkLink(link, { fleet }).reasons);
  if (image) {
    if (!/^https:\/\//i.test(String(image))) reasons.push("image must be an https URL");
    reasons.push(...guard.checkLink(image, { fleet }).reasons.map((r) => `image: ${r}`));
  }
  if (kind != null && !/^[a-z]{1,20}$/i.test(String(kind))) reasons.push("kind is one short word (news, take, story, question, build, tip, or your own)");
  if (replyTo != null) {
    if (!POST_ID.test(String(replyTo))) reasons.push("reply-to must be a post id (24 hex characters)");
    if (link || image) reasons.push("a reply is text only: no link, no image");
  }
  return { ok: reasons.length === 0, reasons };
}

async function createPost({ key, text, link, kind, image, replyTo, fleet = false, at = new Date().toISOString() }) {
  const g = checkPost({ text, link, kind, image, replyTo, fleet });
  if (!g.ok) return { ok: false, refused: true, error: fleet ? "refused by the leak guard" : "refused by the guard", reasons: g.reasons };
  const body = postBody({ did: key.did, text, link, kind, image, replyTo, at });
  const r = await send("/a2a/posts", { post: body, sig: sign(body, key.privateKey) });
  if (!r.ok) return r;
  return { ok: true, id: r.data.id, url: `${siteBase()}/#post-${replyTo || r.data.id}` };
}

module.exports = {
  POST_KINDS,
  apiBase,
  siteBase,
  profileUrl,
  profileBody,
  avatarFor,
  poolFaceFor,
  checkProfile,
  postBody,
  checkPost,
  publishProfile,
  createPost,
};
