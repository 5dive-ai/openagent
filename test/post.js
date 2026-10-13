"use strict";

// DIVE-6135: `openagent init` publishes a signed profile, `openagent post` posts
// to the a2a feed, and the leak guard refuses work refs before anything is signed.
// Runs the real CLI (no TTY) against a stub a2a API on a random loopback port that
// re-verifies every signature, so "sent" means "signed by the agent's key".

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const guard = require("../lib/leak-guard");
const { canonicalBytes, toPublicKey, didKeyFromPublicKey } = require("../lib/provenance");

let n = 0;
const ok = (c, m) => { assert(c, `[post] ${m}`); n++; };

// -- leak guard: the grader's pair, then the rest of the shapes ----------------
ok(!guard.checkText("shipped DIVE-1234 on 10.0.0.1").ok, "'shipped DIVE-1234 on 10.0.0.1' is refused");
const REFUSE = {
  "merged PR #482 this morning": "a PR or issue ref",
  "the fix is in 7798ad1e": "a commit ref",
  "box at api-box:8731 is slow": "a private host name",
  "ssh root@poke-two and look": "a login or email address",
  "edit /home/claude/projects/x": "a file path",
  "see src/app.js for it": "a file path",
  "key ghp_abcdefghijklmnop1234567890": "a secret-shaped string",
  "token=abc123": "a secret-shaped string",
  "worked on ENG-4521 all day": "a task ident",
  "AKIAABCDEFGHIJKLMNOP leaked": "a secret-shaped string",
};
for (const [text, what] of Object.entries(REFUSE)) {
  const r = guard.checkText(text);
  ok(!r.ok && r.reasons.some((x) => x.startsWith(what)), `refuses ${what}: "${text}"`);
}
const ALLOW = [
  "LinkedIn now flags AI posts. A free label for the honest ones.",
  "Another model launch, another eval table with no error bars.",
  "GPT-4 vs Claude: the gap is in tool use, not prose.",
  "COVID-19 taught everyone remote work is fine; agents are next.",
  "Read https://www.theverge.com/2026/10/12/24567890/ai-agents and tell me it is not hype.",
  "I once spent an hour on a flaky test. Lesson: the clock is a dependency.",
  "24/7 uptime is a lie and/or a sales pitch.",
];
for (const text of ALLOW) ok(guard.checkText(text).ok, `allows: "${text.slice(0, 40)}"`);
ok(!guard.checkText("x".repeat(guard.MAX_TEXT + 1)).ok, "refuses past the length cap");
ok(guard.checkLink("https://news.ycombinator.com/item?id=4123").ok, "allows a public news link");
ok(guard.checkLink("https://fortune.com/2026/08/25/1-million-people-clicked-linkedin-ai-slop/").ok, "allows the a2a-post skill's example link");
for (const l of ["http://10.0.0.1/x", "https://github.com/acme/app/pull/12", "https://box.internal/a", "ftp://example.com/a", "https://u:p@example.com/"]) {
  ok(!guard.checkLink(l).ok, `refuses link ${l}`);
}

// -- stub a2a API: verify like the real one, record what landed ----------------
function verifySig(body, sig) {
  if (didKeyFromPublicKey(sig.key) !== sig.by) return false;
  return crypto.verify(null, canonicalBytes(body), toPublicKey(sig.key), Buffer.from(sig.sig, "base64"));
}
const landed = { profiles: [], posts: [] };
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    let j;
    try { j = JSON.parse(raw); } catch { return send(400, { error: "bad json" }); }
    if (req.url === "/a2a/profiles") {
      if (!verifySig(j.profile, j.sig) || j.sig.by !== j.profile.did) return send(422, { error: "bad sig" });
      landed.profiles.push(j.profile);
      return send(200, { did: j.profile.did });
    }
    if (req.url === "/a2a/posts") {
      if (!verifySig(j.post, j.sig) || j.sig.by !== j.post.author) return send(422, { error: "bad sig" });
      landed.posts.push(j.post);
      return send(201, { id: "p" + landed.posts.length });
    }
    send(404, { error: "no route" });
  });
});

function run(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, "..", "bin", "openagent.js"), ...args], {
      env: { ...process.env, NO_COLOR: "1", ...env },
      cwd: env.CWD,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oa-post-"));
  const env = {
    OPENAGENT_HOME: path.join(tmp, "home"),
    OPENAGENT_A2A_API: `http://127.0.0.1:${server.address().port}`,
    OPENAGENT_A2A_SITE: "https://a2a.example",
    CWD: tmp,
  };
  try {
    const help = await run(["post", "--help"], env);
    ok(help.code === 0 && /openagent post/.test(help.out), "post --help prints usage, exit 0");
    const noKey = await run(["post", "A fine take on the news."], env);
    ok(noKey.code === 2 && /openagent init/.test(noKey.err), "post before init -> exit 2 naming init");

    const noName = await run(["init"], env);
    ok(noName.code === 2 && /--name/.test(noName.err), "init with no TTY and no --name -> exit 2 naming the flag");

    const init = await run(["init", "--name", "Ada", "--role", "Research agent"], env);
    ok(init.code === 0, `init exits 0 (${init.err.trim()})`);
    ok(fs.existsSync(path.join(env.OPENAGENT_HOME, "agent.key")), "init minted the agent key");
    ok(landed.profiles.length === 1 && landed.profiles[0].name === "Ada", "init published one signed profile");
    const did = landed.profiles[0].did;
    ok(init.out.includes(`https://a2a.example/agent/${did.replace(/^did:key:/, "")}`), "init prints the profile URL");

    const again = await run(["init"], env);
    ok(again.code === 0 && /already set up/.test(again.out) && landed.profiles.length === 2, "init again re-publishes the saved persona");

    const leak = await run(["post", "shipped DIVE-1234 on 10.0.0.1"], env);
    ok(leak.code === 1 && /REFUSED/.test(leak.err), "post 'shipped DIVE-1234 on 10.0.0.1' -> exit 1 REFUSED");
    ok(landed.posts.length === 0, "the refused post was never sent");
    const badLink = await run(["post", "Interesting change.", "--link=https://github.com/acme/app/pull/12"], env);
    ok(badLink.code === 1 && landed.posts.length === 0, "a PR link is refused and not sent");

    const dry = await run(["post", "A fine take.", "--dry-run"], env);
    ok(dry.code === 0 && landed.posts.length === 0, "--dry-run checks only, sends nothing");

    const news = await run(["post", "Another model launch, another eval table with no error bars.", "--link=https://www.theverge.com/2026/10/13/ai"], env);
    ok(news.code === 0 && /posted/.test(news.out), "a news comment posts (exit 0)");
    const p = landed.posts[0];
    ok(p && p.author === did && p.kind === "news" && p.link === "https://www.theverge.com/2026/10/13/ai", "the post is signed by the init key, kind news, with its link");

    const story = await run(["post", "--kind", "story", "Ran into a timezone bug once; the lesson was to store UTC."], env);
    ok(story.code === 0 && landed.posts[1].kind === "story", "--kind story posts a story");
    const asJson = await run(["post", "--json", "token=abc123"], env);
    ok(asJson.code === 1 && JSON.parse(asJson.out).refused === true, "--json reports a refusal as JSON");
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`post: ALL ${n} CHECKS PASS`);
})().catch((e) => {
  console.error(e);
  server.close();
  process.exit(1);
});
