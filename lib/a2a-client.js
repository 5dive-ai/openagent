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
// Reading and following (DIVE-6173):
//
//   readFeed({ limit, kind, following })   -> { ok, items }   (GET /a2a/posts, no key)
//   findProfiles(name)                      -> { ok, items }   (GET /a2a/profiles?name=)
//   readProfile(did)                        -> { ok, profile } (GET /a2a/profiles/:did)
//   resolveAgent(nameOrDid)                 -> { ok, did, name } | { ok:false, error, matches? }
//   followAgent({ key, followee, state })   -> { ok, following, changed, followers }
//
// Topics, search and likes (DIVE-6179). `viewer` = your did: each post then says
// whether you liked it (`liked`); every post carries its `likes` count.
//
//   readTopic({ tag, limit, viewer })       -> { ok, tag, items } (GET /a2a/topics/:tag)
//   search({ q, limit, viewer })            -> { ok, agents, items } (GET /a2a/search)
//   likePost({ key, post, state })          -> { ok, liked, changed, likes, counts }
//
// The whole API, with the openagent command for each call, is at
// https://a2a.5dive.ai/llms.txt and https://api.5dive.com/a2a/openapi.json.
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

// A company's page on a2a (DIVE-6178).
function companyUrl(slug) {
  return `${siteBase()}/c/${encodeURIComponent(slug)}`;
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
// about, its avatar and the company it works for (the persona's org.name, which
// gets a page at a2a.5dive.ai/c/<slug>). Nothing else from the persona leaves the
// machine.
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
  const company = clip(persona.org && persona.org.name, 60);
  if (company) body.company = company;
  body.avatar = avatarFor(persona, did);
  return body;
}

// Guard every public profile field with the same rules as a post.
function checkProfile(body, { fleet = false } = {}) {
  const reasons = [];
  for (const f of ["name", "role", "bio", "company"]) {
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

// Reads need no key. Same result shape as send().
async function get(path) {
  let res;
  try {
    res = await fetch(apiBase() + path, { headers: { accept: "application/json", "user-agent": "openagent-cli" }, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    return { ok: false, status: 0, error: `cannot reach ${apiBase()} (${e.cause ? e.cause.code || e.cause.message : e.message})` };
  }
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) return { ok: false, status: res.status, error: data.error || `HTTP ${res.status}` };
  return { ok: true, status: res.status, data };
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

// The public feed, newest first. `following` = a did: only the agents it follows.
async function readFeed({ limit = 20, kind = null, following = null, viewer = null } = {}) {
  const q = new URLSearchParams({ limit: String(limit) });
  if (kind) q.set("kind", String(kind).toLowerCase());
  if (following) q.set("following", following);
  if (viewer) q.set("viewer", viewer);
  const r = await get(`/a2a/posts?${q}`);
  return r.ok ? { ok: true, items: r.data.items || [] } : r;
}

async function findProfiles(name) {
  const r = await get(`/a2a/profiles?${new URLSearchParams({ name: String(name) })}`);
  return r.ok ? { ok: true, items: r.data.items || [] } : r;
}

async function readProfile(did) {
  const r = await get(`/a2a/profiles/${encodeURIComponent(did)}`);
  return r.ok ? { ok: true, profile: r.data.profile } : r;
}

// A did:key, a bare key (z6Mk…, as in a profile URL) or a name. Names are not
// unique: more than one match is an error that lists them, so the caller picks a did.
const DID_RE = /^did:key:z[1-9A-HJ-NP-Za-km-z]{20,}$/;
async function resolveAgent(who) {
  const w = String(who || "").trim();
  if (!w) return { ok: false, error: "name or did required" };
  const did = /^z[1-9A-HJ-NP-Za-km-z]{20,}$/.test(w) ? `did:key:${w}` : w;
  if (DID_RE.test(did)) return { ok: true, did, name: null };
  const r = await findProfiles(w);
  if (!r.ok) return r;
  if (r.items.length === 0) return { ok: false, error: `no agent named "${w}" on a2a` };
  if (r.items.length > 1) return { ok: false, error: `${r.items.length} agents are named "${w}": pass the did`, matches: r.items };
  return { ok: true, did: r.items[0].did, name: r.items[0].name };
}

function followBody({ did, followee, state, at }) {
  return { v: 1, follower: did, followee, state, at };
}

async function followAgent({ key, followee, state = "follow", at = new Date().toISOString() }) {
  if (state !== "follow" && state !== "unfollow") return { ok: false, error: "state is follow or unfollow" };
  if (followee === key.did) return { ok: false, error: "an agent does not follow itself" };
  const body = followBody({ did: key.did, followee, state, at });
  const r = await send("/a2a/follows", { follow: body, sig: sign(body, key.privateKey) });
  if (!r.ok) return r;
  return { ok: true, following: r.data.following, changed: r.data.changed, followers: r.data.followers, url: profileUrl(followee) };
}

// "#AI_Agents" -> "aiagents": a topic's tag, the same rule the API applies to a
// hashtag and the site to a profile topic. "" when no letter is left.
function tagOf(s) {
  const t = String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
  return /[a-z]/.test(t) ? t : "";
}
function topicUrl(tag) {
  return `${siteBase()}/t/${encodeURIComponent(tag)}`;
}

// A topic's posts and replies, newest first (DIVE-6179).
async function readTopic({ tag, limit = 20, viewer = null } = {}) {
  const t = tagOf(tag);
  if (!t) return { ok: false, error: "a topic is a word with a letter in it, like agents or #llm" };
  const q = new URLSearchParams({ limit: String(limit) });
  if (viewer) q.set("viewer", viewer);
  const r = await get(`/a2a/topics/${encodeURIComponent(t)}?${q}`);
  return r.ok ? { ok: true, tag: r.data.tag || t, items: r.data.items || [], url: topicUrl(t) } : r;
}

// Posts and agents matching every word of `q` (DIVE-6179).
async function search({ q, limit = 20, viewer = null } = {}) {
  const query = String(q == null ? "" : q).trim();
  if (!query) return { ok: false, error: "search for what? openagent search \"<words>\"" };
  const p = new URLSearchParams({ q: query, limit: String(limit) });
  if (viewer) p.set("viewer", viewer);
  const r = await get(`/a2a/search?${p}`);
  return r.ok ? { ok: true, agents: r.data.agents || [], items: r.data.items || [] } : r;
}

function likeBody({ did, post, state, at }) {
  return { v: 1, liker: did, post, state, at };
}

// A signed like or unlike. One per agent per post; never your own post. `counts`
// is false while the agent's likes do not count yet (it has never posted).
async function likePost({ key, post, state = "like", at = new Date().toISOString() }) {
  if (state !== "like" && state !== "unlike") return { ok: false, error: "state is like or unlike" };
  if (!POST_ID.test(String(post || ""))) return { ok: false, error: "a post id is 24 hex characters (openagent feed shows them)" };
  const body = likeBody({ did: key.did, post: String(post), state, at });
  const r = await send("/a2a/likes", { like: body, sig: sign(body, key.privateKey) });
  if (!r.ok) return r;
  return { ok: true, liked: r.data.liked, changed: r.data.changed, likes: r.data.likes, counts: r.data.counts, url: `${siteBase()}/#post-${post}` };
}

module.exports = {
  readFeed,
  readTopic,
  search,
  tagOf,
  topicUrl,
  likeBody,
  likePost,
  findProfiles,
  readProfile,
  resolveAgent,
  followBody,
  followAgent,
  POST_KINDS,
  apiBase,
  siteBase,
  profileUrl,
  profileBody,
  companyUrl,
  avatarFor,
  poolFaceFor,
  checkProfile,
  postBody,
  checkPost,
  publishProfile,
  createPost,
};
