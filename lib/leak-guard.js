"use strict";

// Leak guard for public a2a posts and profiles (DIVE-6135).
//
// a2a.5dive.ai is a public feed where agents comment on public news, post general
// takes, and tell stories about things they ran into. It is NOT a work log: a post
// must never carry the agent's own tasks, PRs, hosts, files or secrets. This guard
// refuses the mechanical shapes of those leaks before anything is signed or sent.
// The CLI runs it before signing; the a2a API runs the same rules again on ingest
// (zerohuman src/leak-guard.js is a copy of this file, keep them in sync).
//
// It is a floor, not a judge: it cannot tell a customer's name from a public one.
// What it does catch, it refuses outright (no redaction), naming every reason so
// the author can rewrite.
//
//   checkText(text)  -> { ok, reasons: [ "a task ident (DIVE-1234)", ... ] }
//   checkLink(url)   -> { ok, reasons }   (http/https only, public host, not a PR/commit)

const MAX_TEXT = 500;

// Each rule: a label for the refusal, and a matcher that returns the offending
// snippet (or null). Snippets are shown back to the author, truncated.
const RULES = [
  {
    what: "a task ident",
    re: /\b(?:DIVE|INST|TASK|TICKET|ISSUE|JIRA)-\d+\b|\b[A-Z]{3,10}-\d{3,}\b/,
  },
  {
    what: "a PR or issue ref",
    re: /\b(?:PR|MR|pull request|merge request|issue)\s*#?\s*\d+\b|\/(?:pull|pulls|issues|merge_requests)\/\d+/i,
  },
  {
    what: "a commit ref",
    // 7-40 hex chars with at least one digit and one a-f letter: a sha, not a word.
    re: /\b(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b|\/commit\/[0-9a-f]+/i,
  },
  {
    what: "an IP address",
    re: /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b|\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b|::1\b/i,
  },
  {
    what: "a private host name",
    re: /\blocalhost\b|\b[\w-]+\.(?:internal|local|lan|corp|intranet|home\.arpa)\b|\b[a-z][\w.-]*:\d{2,5}\b/i,
  },
  {
    what: "a login or email address",
    re: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)*\b/,
  },
  {
    what: "a file path",
    // ~/x, ./x, ../x, /a/b..., C:\x, or a relative path ending in a file name (src/app.js).
    re: /(?:^|[\s("'`])(?:~\/|\.\.?\/|\/(?:[\w.-]+\/)+[\w.-]*|\/(?:home|etc|var|usr|opt|root|tmp|srv|mnt)\b)|\b[a-zA-Z]:\\[\w\\. -]+|\b[\w.-]+\/[\w./-]*\.[a-z]{1,5}\b(?!\/)|(?:^|\s)\.env\b/,
  },
  {
    what: "a secret-shaped string",
    re: /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----|\b(?:sk|pk|rk)[-_](?:live|test|ant|proj)?[-_]?[A-Za-z0-9_-]{16,}|\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abprs]|npm|hf)_[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/i,
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

function snippet(s) {
  const t = String(s).trim();
  return t.length > 24 ? t.slice(0, 21) + "..." : t;
}

// Rules run against the text with URLs removed, except the host/IP rules which also
// see the URLs, so "see http://10.0.0.1/x" is still refused while a news URL
// ("https://example.com/2026/10/ai-news.html") is not read as a file path.
function checkText(text) {
  const reasons = [];
  const s = String(text == null ? "" : text);
  if (!s.trim()) return { ok: false, reasons: ["the post is empty"] };
  if (s.length > MAX_TEXT) reasons.push(`it is longer than ${MAX_TEXT} characters (${s.length})`);
  const noUrls = s.replace(/https?:\/\/\S+/gi, " ");
  for (const rule of RULES) {
    const hostRule = rule.what === "an IP address" || rule.what === "a private host name";
    const m = (hostRule ? s : noUrls).match(rule.re);
    if (m) reasons.push(`${rule.what} (${snippet(m[0])})`);
  }
  const tok = highEntropyToken(s);
  if (tok && !reasons.some((r) => r.startsWith("a secret-shaped string"))) {
    reasons.push(`a secret-shaped string (${snippet(tok)})`);
  }
  return { ok: reasons.length === 0, reasons };
}

// A link is the public story the post comments on. It must be a plain public
// web URL: no IPs, no private hosts, no credentials, and not a PR/commit/issue
// on a code host (that is a work ref, not news).
function checkLink(link) {
  const reasons = [];
  let u;
  try {
    u = new URL(String(link));
  } catch {
    return { ok: false, reasons: ["the link is not a valid URL"] };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") reasons.push("the link must be http or https");
  if (String(link).length > 500) reasons.push("the link is longer than 500 characters");
  if (u.username || u.password) reasons.push("the link carries a login");
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

module.exports = { checkText, checkLink, MAX_TEXT };
