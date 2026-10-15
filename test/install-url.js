"use strict";

// `openagent install --to=<runtime> <https-url>` (DIVE-6330). A local https
// server (self-signed cert, trusted by the CLI child through
// NODE_EXTRA_CA_CERTS) serves each case; every arm runs against a temp $HOME
// and a temp TMPDIR, so "wrote nothing" and "left no download behind" are both
// read off the disk, not off the CLI's own word.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { spawn, spawnSync } = require("child_process");
const YAML = require("yaml");

const CLI = path.join(__dirname, "..", "bin", "openagent.js");
let pass = 0;
const fail = [];
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail.push(`${name}: ${e.message}`);
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "oa-install-url-"));

const QUILL = {
  openagent: "0.2",
  id: "quill",
  name: "Quill",
  role: "Release Archivist",
  behavior: "Keeps the changelog honest.",
  face: { ref: "https://example.com/quill.png", anchor: "owl-eyed archivist, ink-stained fingers" },
  voice: { written: { rules: ["dry wit"], sample: "2026-10-13: shipped." } },
};
const GOOD = YAML.stringify(QUILL);
const INVALID = YAML.stringify({ openagent: "0.2", name: "No Id" });

// A throwaway CA-less cert for 127.0.0.1; the CLI child trusts it explicitly.
function makeCert(dir) {
  const key = path.join(dir, "key.pem"), cert = path.join(dir, "cert.pem");
  const r = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
    "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`openssl could not make a test cert: ${r.stderr || r.error}`);
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert), certFile: cert };
}

function route(base, req, res) {
  const p = req.url;
  if (p === "/pack-files/quill.persona.yaml") return res.writeHead(200, { "content-type": "application/yaml" }), res.end(GOOD);
  if (p === "/pack-files/broken.persona.yaml") return res.writeHead(200, { "content-type": "application/yaml" }), res.end(INVALID);
  if (p === "/big-declared.persona.yaml") return res.writeHead(200, { "content-length": String(2 * 1024 * 1024) }), res.end(Buffer.alloc(2 * 1024 * 1024, 0x20));
  if (p === "/big-chunked.persona.yaml") {
    // No content-length: the cap has to hold while streaming.
    res.writeHead(200, { "content-type": "application/yaml" });
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    let sent = 0;
    const pump = () => {
      while (sent < 2 * 1024 * 1024) {
        sent += chunk.length;
        if (!res.write(chunk)) return res.once("drain", pump);
      }
      res.end();
    };
    res.on("error", () => {});
    return pump();
  }
  if (p === "/hop") return res.writeHead(302, { location: "/pack-files/quill.persona.yaml" }), res.end();
  if (p === "/to-http") return res.writeHead(301, { location: `http://127.0.0.1:${base.port}/pack-files/quill.persona.yaml` }), res.end();
  if (p.startsWith("/loop/")) {
    const n = Number(p.slice(6));
    return res.writeHead(302, { location: n > 0 ? `/loop/${n - 1}` : "/pack-files/quill.persona.yaml" }), res.end();
  }
  res.writeHead(404), res.end("not found");
}

function run(args, { home, tmpdir, certFile }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: home,
      env: { ...process.env, HOME: home, TMPDIR: tmpdir, CODEX_HOME: "", CLAUDE_CONFIG_DIR: "", HERMES_HOME: "", OPENAGENT_HOME: "", NO_COLOR: "1",
        OPENAGENT_A2A_API: "http://127.0.0.1:9", NODE_EXTRA_CA_CERTS: certFile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

// Everything under a dir, relative — "wrote nothing" means this stays [].
function tree(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tree(p).map((x) => path.join(e.name, x)));
    else out.push(e.name);
  }
  return out;
}

(async () => {
  const certDir = tmp();
  const { key, cert, certFile } = makeCert(certDir);
  const base = {};
  const server = https.createServer({ key, cert }, (req, res) => route(base, req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base.port = server.address().port;
  const url = (p) => `https://127.0.0.1:${base.port}${p}`;
  const env = () => ({ home: tmp(), tmpdir: tmp(), certFile });

  await t("installs from an https link: block written, persona copy kept in ~/.openagent, no download left behind", async () => {
    const e = env();
    fs.mkdirSync(path.join(e.home, ".codex"));
    const r = await run(["install", "--to=codex", url("/pack-files/quill.persona.yaml")], e);
    assert.strictEqual(r.code, 0, r.out);
    const agents = fs.readFileSync(path.join(e.home, ".codex", "AGENTS.md"), "utf8");
    assert.match(agents, /You are \*\*Quill\*\*/);
    const kept = tree(path.join(e.home, ".openagent")).filter((f) => f.endsWith("quill.persona.yaml"));
    assert.strictEqual(kept.length, 1, `kept copies: ${kept}`);
    assert.strictEqual(fs.readFileSync(path.join(e.home, ".openagent", kept[0]), "utf8"), GOOD);
    assert.deepStrictEqual(tree(e.tmpdir), [], "the temp download must be removed");
    assert.match(r.out, /answers as Quill/);
  });

  await t("--dry-run with a link prints the plan and writes nothing", async () => {
    const e = env();
    const r = await run(["install", "--to=codex", url("/pack-files/quill.persona.yaml"), "--dry-run"], e);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /would-created\s+\S*\.codex\/AGENTS\.md/);
    assert.match(r.out, /\| You are \*\*Quill\*\*/);
    assert.deepStrictEqual(tree(e.home), []);
    assert.deepStrictEqual(tree(e.tmpdir), []);
  });

  await t("follows a same-scheme redirect", async () => {
    const e = env();
    const r = await run(["install", "--to=codex", url("/hop")], e);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(fs.readFileSync(path.join(e.home, ".codex", "AGENTS.md"), "utf8"), /Quill/);
  });

  await t("3 redirects are followed, a 4th is refused", async () => {
    const ok = env();
    assert.strictEqual((await run(["install", "--to=codex", url("/loop/2")], ok)).code, 0);
    const e = env();
    const r = await run(["install", "--to=codex", url("/loop/3")], e);
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /more than 3 redirects/);
    assert.deepStrictEqual(tree(e.home), []);
  });

  // Refusals: each writes nothing at all — no slot, no ~/.openagent copy, no temp file.
  const refusals = [
    ["a plain http:// link", "http://127.0.0.1:9/quill.persona.yaml", /must be https:\/\//],
    ["a redirect down to http://", url("/to-http"), /redirect must be https:\/\//],
    ["an oversize body (declared length)", url("/big-declared.persona.yaml"), /over the 1048576-byte cap/],
    ["an oversize body (streamed, no length)", url("/big-chunked.persona.yaml"), /over the 1048576-byte cap/],
    ["an invalid persona", url("/pack-files/broken.persona.yaml"), /is not a valid persona — nothing was installed/],
    ["a 404", url("/nope.persona.yaml"), /HTTP 404/],
  ];
  for (const [what, link, why] of refusals) {
    await t(`refuses ${what} and writes nothing`, async () => {
      const e = env();
      const r = await run(["install", "--to=codex", link], e);
      assert.strictEqual(r.code, 1, r.out);
      assert.match(r.out, why);
      assert.deepStrictEqual(tree(e.home), [], "home must stay empty");
      assert.deepStrictEqual(tree(e.tmpdir), [], "no download left behind");
    });
  }

  await t("negative control: the same invalid persona as a local file refuses too (the link adds no new check, and skips none)", async () => {
    const e = env();
    const f = path.join(e.tmpdir, "broken.persona.yaml");
    fs.writeFileSync(f, INVALID);
    const r = await run(["install", "--to=codex", f], e);
    assert.strictEqual(r.code, 1, r.out);
    assert.ok(!fs.existsSync(path.join(e.home, ".codex", "AGENTS.md")));
  });

  await t("--to=5dive off a box names the link, not a temp path", async () => {
    const e = env();
    const r = await run(["install", "--to=5dive", url("/pack-files/quill.persona.yaml")], { ...e, home: e.home });
    assert.strictEqual(r.code, 0, r.out);
    if (/Get a box/.test(r.out)) assert.ok(r.out.includes(`install --to=5dive ${url("/pack-files/quill.persona.yaml")}`), r.out);
    else assert.ok(r.out.includes(`openagent install --to=5dive ${url("/pack-files/quill.persona.yaml")} --yes`), r.out);
    assert.doesNotMatch(r.out, /openagent-fetch-/);
  });

  await t("--remove refuses a link (nothing to fetch for a removal)", async () => {
    const e = env();
    const r = await run(["install", "--to=codex", "--remove", url("/pack-files/quill.persona.yaml")], e);
    assert.strictEqual(r.code, 2, r.out);
  });

  server.close();
  console.log(`\n${pass} passed, ${fail.length} failed`);
  if (fail.length) {
    for (const f of fail) console.log(`  - ${f}`);
    process.exit(1);
  }
})();
