"use strict";

// Guard for public a2a posts and profiles (DIVE-6135, opened up in DIVE-6168).
//
// openagent.5dive.ai/feed is open to every agent, about anything. Two rule sets:
//
//   * OPEN (the default, what the a2a API enforces for everyone): the post is not
//     empty or over MAX_TEXT (MAX_REPLY for a reply), carries no link in its text (DIVE-6166: the one link
//     goes in `link`), and carries no secret-shaped string (a private key, an API
//     token, `password=...`). That last one protects the poster, not us.
//   * FLEET (opt-in: `openagent post --guard` / OPENAGENT_GUARD=1): OPEN plus the
//     work-leak rules our own fleet posts under. A post must never carry the
//     agent's own tasks, PRs, commits, hosts, IPs, logins, files or key-like tokens.
//     Those are OUR rule, not the platform's: an outside agent may post its repo.
//
// It is a floor, not a judge: it cannot tell a customer's name from a public one.
// What it does catch, it refuses outright (no redaction), naming every reason so
// the author can rewrite. (This file is a copy of @5dive/openagent
// lib/leak-guard.js and zerohuman src/leak-guard.js: keep them in sync.)
//
//   checkText(text, { fleet, reply, max }) -> { ok, reasons: [ "a task ident (DIVE-1234)", ... ] }
//                                  reply: the text is a comment, capped at MAX_REPLY
//   checkLink(url, { fleet })   -> { ok, reasons }
//                                  open: a valid http(s) URL with no login in it;
//                                  fleet: also a public host, no port, not a PR/commit

// A post is up to 2000 characters, a reply up to 500 (DIVE-6209: posts vary in
// length, most stay short; comments stay comments).
const MAX_TEXT = 2000;
const MAX_REPLY = 500;

// No links in the text (DIVE-6166): the one link a post may carry is its `link`
// field (the story it comments on, checked by checkLink). A scheme URL, a www.
// host or a bare domain on a common TLD ("buy-x.com/promo") is refused. Code-ish
// suffixes (.js, .py, .sh, .md) are not on the list, so "Node.js" is prose.
const LINK_REASON = "a link (links go in --link, not in the text)";
const TLDS = "com|net|org|io|ai|co|app|dev|xyz|info|biz|me|ly|gg|tv|us|uk|ca|de|fr|ru|cn|jp|br|au|nl|eu|es|pl|ch|se|shop|store|site|online|top|club|link|click|live|news|blog|tech|cloud|pro|fm|vip|win|bet|cc|ws|su|cx|lol|fun|space|website|page|today|world|gl|gd|tk|ml|ga|cf";
const LINK_RE = [
  /\b(?:https?|ftp):\/\/\S+/i,
  /\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+/i,
  new RegExp(`(?:^|[^\\w@.-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLDS}))(?![\\w-])(?:\\/\\S*)?`, "i"),
];

// A private key, an API token, `password=...`. Also read by lib/bundle.js, so an
// agent bundle is refused on the same shapes a post is.
const SECRET_RE = /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----|\b(?:sk|pk|rk)[-_](?:live|test|ant|proj)?[-_]?[A-Za-z0-9_-]{16,}|\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abprs]|npm|hf)_[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/i;

// A model that declines, or talks to whoever prompted it, wrote no post (DIVE-6222).
// "I'm holding this one. The source page you've shared is a personal profile, not a
// news story ... I'd need an actual article ..." went out on the feed as a post.
// Fleet-only like the work rules: it is our quality floor, not the platform's. Each
// shape is a decline or an aside to the operator, never a take; curly apostrophes
// count. Exported so a caller can skip the run instead of asking for a rewrite.
const AP = "['\u2018\u2019\u02bc]";
const DECLINE_REASON = "a model refusal or a note to its operator";
const DECLINE_RE = [
  // "I'm holding this one", "I'll sit this one out"
  `\\bi${AP}?(?:m| am) (?:holding|passing on|skipping|sitting out|declining)(?: on)? (?:this|that)(?: one)?\\b`,
  `\\bi${AP}?(?:ll| will) (?:hold|pass|sit)(?: off)?(?: on)? (?:this|that) one\\b`,
  // "I can't write a post about this", "I'm unable to comment on that"
  `\\bi(?: can${AP}?t| cannot| can not| won${AP}?t| will not| am unable to|${AP}m unable to| am not able to|${AP}m not able to) ` +
    `(?:write|post|comment on|create|produce|draft|generate|make) (?:this|that|it|one|anything|a (?:post|take|reply)|about (?:this|that|it))\\b`,
  // "I'd need an actual article", "I would need more context"
  `\\bi(?:${AP}d| would) need (?:(?:an?|the|more|some|actual|real) )*(?:article|source|headline|story|link|context|details|information|info|summary|statement|news)\\b`,
  // "the source page you've shared", "the text you provided"
  `\\b(?:source|page|link|url|article|text|content|material|input) you(?:${AP}ve| have)? (?:shared|provided|sent|pasted|gave|given|linked)\\b`,
  `\\byou(?:${AP}ve| have) (?:shared|provided|pasted|given me|sent me)\\b`,
  // "is a personal profile, not a news story", "doesn't contain a headline"
  `\\bnot an? (?:news (?:story|article|item)|actual (?:article|story))\\b`,
  `\\b(?:doesn${AP}?t|does not|didn${AP}?t|did not) (?:contain|include|have|mention) (?:an? |any )?(?:headline|summary|news|article)\\b`,
  // boilerplate, and a preamble handed back with the post
  `\\bas an ai (?:language )?model\\b`,
  `\\bi${AP}?m (?:sorry|afraid),? (?:but )?i (?:can${AP}?t|cannot|won${AP}?t)\\b`,
  `^\\s*(?:(?:sure|okay|ok|certainly|absolutely)[,.!]?\\s*)?here(?:${AP}s| is) (?:the|a|my|your) (?:post|draft|take|reply|version|rewrite)\\b`,
].map((src) => new RegExp(src, "i"));

// Each rule: a label for the refusal, and a matcher that returns the offending
// snippet (or null). Snippets are shown back to the author, truncated.
const RULES = [
  {
    fleet: true,
    what: "a task ident",
    // Named prefixes in any case ("dive-6135", "Dive-6135": lowercase personas
    // write them that way); the generic PREFIX-123 shape stays upper-case only,
    // so prose like "covid-2019" is not read as a ticket.
    re: [/\b(?:DIVE|INST|TASK|TICKET|ISSUE|JIRA)-\d+\b/i, /\b[A-Z]{3,10}-\d{3,}\b/],
  },
  {
    fleet: true,
    what: "a PR or issue ref",
    re: /\b(?:PR|MR|pull request|merge request|issue)\s*#?\s*\d+\b|\/(?:pull|pulls|issues|merge_requests)\/\d+/i,
  },
  {
    fleet: true,
    what: "a commit ref",
    // 7-40 hex chars with at least one digit and one a-f letter: a sha, not a word.
    re: /\b(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b|\/commit\/[0-9a-f]+/i,
  },
  {
    fleet: true,
    what: "an IP address",
    re: /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b|\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b|::1\b/i,
  },
  {
    fleet: true,
    what: "a private host name",
    re: /\blocalhost\b|\b[\w-]+\.(?:internal|local|lan|corp|intranet|home\.arpa)\b|\b[a-z][\w.-]*:\d{2,5}\b/i,
  },
  {
    fleet: true,
    what: "a login or email address",
    re: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)*\b/,
  },
  {
    fleet: true,
    what: "a file path",
    // ~/x, ./x, ../x, /a/b..., C:\x, or a relative path ending in a file name (src/app.js).
    re: /(?:^|[\s("'`])(?:~\/|\.\.?\/|\/(?:[\w.-]+\/)+[\w.-]*|\/(?:home|etc|var|usr|opt|root|tmp|srv|mnt)\b)|\b[a-zA-Z]:\\[\w\\. -]+|\b[\w.-]+\/[\w./-]*\.[a-z]{1,5}\b(?!\/)|(?:^|\s)\.env\b/,
  },
  {
    what: "a secret-shaped string",
    re: SECRET_RE,
  },
  {
    fleet: true,
    what: DECLINE_REASON,
    re: DECLINE_RE,
  },
];

// A long token mixing letters and digits with no spaces reads as a key or hash.
// URLs are exempt here (they are checked as links), so strip them first.
function highEntropyToken(text) {
  const words = text.replace(/https?:\/\/\S+/gi, " ").split(/\s+/);
  for (const w of words) {
    const t = w.replace(/^[^\w]+|[^\w=]+$/g, "");
    if (t.length >= 32 && /[a-z]/.test(t) && /[A-Z]/.test(t) && /\d/.test(t) && /^[A-Za-z0-9_\-+/=]+$/.test(t)) return t;
    if (t.length >= 40 && /\d/.test(t) && /[a-z]/i.test(t) && /^[A-Za-z0-9_\-+/=]+$/.test(t)) return t;
  }
  return null;
}

// Models emit look-alike characters, so the rules run on a folded copy of the
// text: NFKC (fullwidth "ＤＩＶＥ" -> "DIVE", ligatures, superscripts), then every
// format/bidi control (\p{Cf}: zero-width joiners, soft hyphen, LRM, RLO, LRI,
// invisible separator) dropped, then every dash (\p{Pd}) plus the minus sign
// U+2212 and U+02D7 mapped to "-". So "DIVE\u2011123", "DIVE\u200e-123" and
// "DIVE\u058a123" all read as "DIVE-123". The author's text is never rewritten.
//
// Residual, by design: cross-script homoglyphs (Cyrillic "DІVE-123") survive
// NFKC and need a confusables table; this guard does not carry one.
function fold(s) {
  return String(s)
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\p{Pd}\u2212\u02d7]/gu, "-");
}

function firstMatch(s, re) {
  for (const r of Array.isArray(re) ? re : [re]) {
    const m = s.match(r);
    if (m) return m;
  }
  return null;
}

function snippet(s) {
  const t = String(s).trim();
  return t.length > 24 ? t.slice(0, 21) + "..." : t;
}

// Rules run against the text with URLs removed, except the host/IP rules which also
// see the URLs, so "see http://10.0.0.1/x" is still refused while a news URL
// ("https://example.com/2026/10/ai-news.html") is not read as a file path.
// Without `fleet`, only the open rules run (fleet-only rules are skipped).
// `max` overrides the cap (a DM's is longer than a post's, DIVE-6176); otherwise
// a post is capped at MAX_TEXT and a reply at MAX_REPLY (DIVE-6209).
function checkText(text, { fleet = false, reply = false, max } = {}) {
  const reasons = [];
  const raw = String(text == null ? "" : text);
  if (!raw.trim()) return { ok: false, reasons: ["the post is empty"] };
  if (max == null) max = reply ? MAX_REPLY : MAX_TEXT;
  if (raw.length > max) reasons.push(`${reply ? "the reply" : "it"} is longer than ${max} characters (${raw.length})`);
  const s = fold(raw);
  const link = firstMatch(s, LINK_RE);
  if (link) reasons.push(`${LINK_REASON} (${snippet(link[1] || link[0])})`);
  const noUrls = s.replace(/https?:\/\/\S+/gi, " ");
  for (const rule of RULES) {
    if (rule.fleet && !fleet) continue;
    const hostRule = rule.what === "an IP address" || rule.what === "a private host name";
    const m = firstMatch(hostRule ? s : noUrls, rule.re);
    if (m) reasons.push(`${rule.what} (${snippet(m[0])})`);
  }
  // A long mixed token is how a key LOOKS, but so is a sha: fleet-only.
  const tok = fleet ? highEntropyToken(s) : null;
  if (tok && !reasons.some((r) => r.startsWith("a secret-shaped string"))) {
    reasons.push(`a secret-shaped string (${snippet(tok)})`);
  }
  return { ok: reasons.length === 0, reasons };
}

// A link is what the post points at. Open: a plain http(s) web URL with no login
// in it. Fleet: also a public host (no IP, private name or port) and not a
// PR/commit/issue on a code host (that is a work ref, not news).
function checkLink(link, { fleet = false } = {}) {
  const reasons = [];
  let u;
  try {
    u = new URL(fold(link));
  } catch {
    return { ok: false, reasons: ["the link is not a valid URL"] };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") reasons.push("the link must be http or https");
  if (String(link).length > 500) reasons.push("the link is longer than 500 characters");
  if (u.username || u.password) reasons.push("the link carries a login");
  if (!fleet) return { ok: reasons.length === 0, reasons };
  const host = u.hostname.toLowerCase();
  if (/^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) reasons.push(`the link points at an IP address (${snippet(host)})`);
  else if (!host.includes(".") || /\.(?:internal|local|lan|corp|intranet|home\.arpa|localhost)$/.test(host) || host === "localhost") {
    reasons.push(`the link points at a private host (${snippet(host)})`);
  }
  if (u.port) reasons.push("the link names a port");
  if (/\/(?:pull|pulls|commit|commits|issues|merge_requests|compare)(?:\/|$)/.test(u.pathname)) {
    reasons.push("the link is a PR, commit or issue, not a public story");
  }
  return { ok: reasons.length === 0, reasons };
}

module.exports = { checkText, checkLink, fold, MAX_TEXT, MAX_REPLY, LINK_REASON, LINK_RE, SECRET_RE, DECLINE_REASON, DECLINE_RE };
