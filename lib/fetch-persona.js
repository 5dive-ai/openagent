"use strict";

// `openagent install --to=<runtime> https://…/<id>.persona.yaml` (DIVE-6330):
// fetch a persona from a link instead of a file the user downloaded first.
//
// The body lands in a fresh temp dir under its own file name, and install then
// treats it EXACTLY as a local file: the same validateFile schema check runs
// before any slot is written, and the same copy is kept in ~/.openagent. So a
// link adds one thing — the download — and every refusal it can hit happens
// before install touches a harness.
//
// The link is untrusted, so the fetch is bounded: https only (a redirect to
// http is refused too), at most MAX_REDIRECTS hops, a TIMEOUT_MS budget for the
// whole download, and a MAX_BYTES cap enforced while streaming (a lying or
// absent content-length cannot get past it).

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");

const MAX_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;
// OPENAGENT_FETCH_TIMEOUT_MS exists for the test suite's drip-server arm, so it
// can prove the whole-download limit without waiting the full 15 s.
const TIMEOUT_MS = Number(process.env.OPENAGENT_FETCH_TIMEOUT_MS) > 0 ? Number(process.env.OPENAGENT_FETCH_TIMEOUT_MS) : 15000;

function isUrl(s) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(s || ""));
}

function httpsUrl(raw, label) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${label} is not a valid URL: ${raw}`);
  }
  if (u.protocol !== "https:") throw new Error(`${label} must be https:// — got ${u.protocol}//${u.host}`);
  return u;
}

// The file name the persona is saved (and remembered in ~/.openagent) under:
// the link's own last segment when it looks like a persona file, else a name
// that still reads as one.
function fileNameFor(u) {
  const base = decodeURIComponent(path.posix.basename(u.pathname || ""));
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\.(ya?ml|json)$/.test(base) ? base : "persona.yaml";
}

// The time limit is a wall-clock timer over the WHOLE request, body included —
// not req.setTimeout, which is an idle-socket timer: a server dripping a byte a
// second never goes idle and would hold the download open for days under the cap.
function get(u, deadline) {
  return new Promise((resolveP, rejectP) => {
    const left = deadline - Date.now();
    if (left <= 0) return rejectP(new Error(`timed out after ${TIMEOUT_MS / 1000}s`));
    let timer = null;
    const resolve = (v) => (clearTimeout(timer), resolveP(v));
    const reject = (e) => (clearTimeout(timer), rejectP(e));
    const req = https.get(u, { headers: { accept: "application/yaml, text/yaml, text/plain, */*", "user-agent": "openagent-cli" } }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: new URL(res.headers.location, u).href });
      }
      if (code !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${code}`));
      }
      const declared = Number(res.headers["content-length"]);
      if (declared > MAX_BYTES) {
        res.destroy();
        return reject(new Error(`body is ${declared} bytes, over the ${MAX_BYTES}-byte cap`));
      }
      const chunks = [];
      let n = 0;
      res.on("data", (c) => {
        n += c.length;
        if (n > MAX_BYTES) {
          res.destroy();
          reject(new Error(`body is over the ${MAX_BYTES}-byte cap`));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => resolve({ body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${TIMEOUT_MS / 1000}s`));
      req.destroy();
    }, left);
    req.on("error", reject);
  });
}

// Download `url` into a new temp dir. Resolves { file, dir, url, finalUrl };
// the caller removes `dir` when it is done. Rejects with a one-line reason.
async function fetchPersona(url) {
  const deadline = Date.now() + TIMEOUT_MS;
  let u = httpsUrl(url, "the persona link");
  for (let hops = 0; ; hops++) {
    let r;
    try {
      r = await get(u, deadline);
    } catch (e) {
      throw new Error(`cannot fetch ${u.href}: ${e.message}`);
    }
    if (r.redirect) {
      if (hops >= MAX_REDIRECTS) throw new Error(`cannot fetch ${url}: more than ${MAX_REDIRECTS} redirects`);
      u = httpsUrl(r.redirect, "a redirect");
      continue;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagent-fetch-"));
    const file = path.join(dir, fileNameFor(u));
    fs.writeFileSync(file, r.body);
    return { file, dir, url, finalUrl: u.href };
  }
}

module.exports = { fetchPersona, isUrl, MAX_BYTES, MAX_REDIRECTS, TIMEOUT_MS };
