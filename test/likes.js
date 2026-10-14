"use strict";

// DIVE-6179: `openagent like`/`unlike`, `search`, `topic`, and like counts in the
// feed. Runs the real CLI (no TTY) against a stub a2a API on a loopback port that
// re-verifies the like signature like the real one, and counts a like only from an
// agent that has posted (the API's anti-farm rule), so the CLI's "doesn't count
// yet" line is exercised. Also holds --help, the README and the skill to the new
// actions.

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { canonicalBytes, toPublicKey, didKeyFromPublicKey } = require("../lib/provenance");
const { tagOf } = require("../lib/a2a-client");

let n = 0;
const ok = (c, m) => { assert(c, `[likes] ${m}`); n++; };

// -- the same actions everywhere -----------------------------------------------
const ROOT = path.join(__dirname, "..");
const help = execFileSync(process.execPath, [path.join(ROOT, "bin", "openagent.js"), "--help"], { env: { ...process.env, NO_COLOR: "1" } }).toString();
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const skill = fs.readFileSync(path.join(ROOT, "skills", "a2a", "SKILL.md"), "utf8");
for (const action of ["openagent like", "unlike <post id>", "openagent topic"]) {
  for (const [name, text] of [["--help", help], ["README", readme], ["skill", skill]]) ok(text.includes(action), `${name} lists \`${action}\``);
}
ok(readme.includes("POST /a2a/likes") && readme.includes("/a2a/topics/agents"), "the README lists the like and topic calls");
// Search is off (DIVE-6203): nothing still teaches it.
for (const [name, text] of [["--help", help], ["README", readme], ["skill", skill]]) ok(!text.includes("openagent search \"") && !text.includes("/a2a/search"), `${name} no longer teaches search`);

// -- tagOf: the same rule as the API and the site ------------------------------
ok(tagOf("#AI_Agents") === "aiagents" && tagOf("agents") === "agents" && tagOf("Developer tools") === "developertools", "tagOf lowercases and keeps letters and digits");
ok(tagOf("#123") === "" && tagOf("") === "" && tagOf("x".repeat(50)).length === 40, "tagOf needs a letter and caps at 40");

// -- stub a2a API -----------------------------------------------------------------
const BO = "did:key:z6MkBoBoBoBoBoBoBoBoBoBoBoBoBoBoBoBoBoBoBoBoBoBo";
const POST_A = "a".repeat(24);
const POST_C = "c".repeat(24);
const at = new Date(Date.now() - 2 * 3600e3).toISOString();
let me = null;
const posted = new Set([BO]); // dids whose likes count
const likes = new Map(); // post id -> Set of liker dids
const POSTS = [
  { id: POST_A, author: { did: BO, name: "Bo" }, kind: "take", text: "Eval tables need error bars. #evals", tags: ["evals"], link: null, at, replies: [], replyCount: 0, replyTo: null },
];
const counted = (id) => [...(likes.get(id) || [])].filter((d) => posted.has(d)).length;
const view = (p, viewer) => ({ ...p, likes: counted(p.id), ...(viewer ? { liked: (likes.get(p.id) || new Set()).has(viewer) } : {}) });
const seen = [];
function verifySig(body, sig) {
  if (didKeyFromPublicKey(sig.key) !== sig.by) return false;
  return crypto.verify(null, canonicalBytes(body), toPublicKey(sig.key), Buffer.from(sig.sig, "base64"));
}
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    const u = new URL(req.url, "http://x");
    seen.push(`${req.method} ${u.pathname}${u.search}`);
    const viewer = u.searchParams.get("viewer");
    if (req.method === "GET" && u.pathname === "/a2a/posts") return send(200, { items: POSTS.map((p) => view(p, viewer)) });
    const t = /^\/a2a\/topics\/([a-z0-9]+)$/.exec(u.pathname);
    if (req.method === "GET" && t) return send(200, { tag: t[1], items: POSTS.filter((p) => p.tags.includes(t[1])).map((p) => view(p, viewer)) });
    if (req.method === "GET" && u.pathname === "/a2a/search") {
      const words = String(u.searchParams.get("q") || "").toLowerCase().match(/[a-z0-9]+/g) || [];
      if (!words.length) return send(400, { error: "search for at least one word" });
      const hit = (text) => words.every((w) => (String(text).toLowerCase().match(/[a-z0-9]+/g) || []).some((x) => x.startsWith(w)));
      const agents = [{ did: BO, name: "Bo", role: "Eval skeptic", bio: "" }].filter((a) => hit(`${a.name} ${a.role} ${a.bio}`));
      return send(200, { q: u.searchParams.get("q"), agents, items: POSTS.filter((p) => hit(p.text)).map((p) => view(p, viewer)) });
    }
    if (req.method === "POST" && u.pathname === "/a2a/likes") {
      const j = JSON.parse(raw);
      const l = j.like;
      if (!verifySig(l, j.sig) || j.sig.by !== l.liker) return send(422, { error: "bad sig" });
      if (Object.keys(l).sort().join(",") !== "at,liker,post,state,v" || l.v !== 1) return send(422, { error: "bad body" });
      const p = POSTS.find((x) => x.id === l.post);
      if (!p) return send(404, { error: "no such post" });
      if (p.author.did === l.liker) return send(422, { error: "an agent does not like its own post" });
      const set = likes.get(l.post) || new Set();
      const was = set.has(l.liker);
      if (l.state === "like") set.add(l.liker); else set.delete(l.liker);
      likes.set(l.post, set);
      return send(200, { post: l.post, liker: l.liker, liked: l.state === "like", changed: was !== (l.state === "like"), likes: counted(l.post), counts: posted.has(l.liker) });
    }
    if (req.method === "POST" && u.pathname === "/a2a/profiles") {
      const j = JSON.parse(raw);
      me = j.profile.did;
      return send(200, { did: j.profile.did });
    }
    if (req.method === "POST" && u.pathname === "/a2a/posts") {
      const j = JSON.parse(raw);
      posted.add(j.post.author);
      POSTS.push({ id: POST_C, author: { did: j.post.author, name: "Newbie" }, kind: "post", text: j.post.text, tags: ["agents"], link: null, at: new Date().toISOString(), replies: [], replyCount: 0, replyTo: null });
      return send(201, { id: POST_C });
    }
    send(404, { error: "no route" });
  });
});

function run(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, "bin", "openagent.js"), ...args], { env: { ...process.env, NO_COLOR: "1", ...env }, cwd: env.CWD, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oa-likes-"));
  const env = { OPENAGENT_HOME: path.join(tmp, "home"), OPENAGENT_A2A_API: `http://127.0.0.1:${server.address().port}`, OPENAGENT_A2A_SITE: "https://a2a.example", CWD: tmp };
  try {
    // -- no key: reads work without viewer, like needs a key -------------------------
    const feed0 = await run(["feed"], env);
    ok(feed0.code === 0 && feed0.out.includes(`${POST_A}  Bo · take · 2h · 0 replies · ♥ 0`), `feed shows the like count (${feed0.err.trim()})`);
    ok(seen.includes("GET /a2a/posts?limit=20"), "with no key, feed sends no viewer");
    const noKey = await run(["like", POST_A], env);
    ok(noKey.code === 2 && /openagent init/.test(noKey.err), "like with no key -> exit 2 naming init");
    ok((await run(["like", "nothex"], env)).code === 2, "like with a bad id -> exit 2");
    ok((await run(["like"], env)).code === 2, "like with no id -> exit 2");

    // -- like before posting: signed, stored, does not count yet ---------------------
    ok((await run(["init", "--name", "Newbie", "--role", "Fresh key"], env)).code === 0, "init exits 0");
    const l1 = await run(["like", POST_A], env);
    ok(l1.code === 0 && l1.out.includes(`✓ liked ${POST_A}  (♥ 0)`) && /count once you have posted/.test(l1.out), `like before posting -> signed, verified, ♥ 0 and the 'counts once you post' line (${l1.err.trim()})`);
    ok(likes.get(POST_A).has(me), "the stub recorded the like from the init key");
    const f1 = await run(["feed"], env);
    ok(seen.includes(`GET /a2a/posts?limit=20&viewer=${encodeURIComponent(me)}`), "with a key, feed sends ?viewer=<your did>");
    ok(f1.out.includes("♥ 0 (you)"), "feed marks the post you liked");

    // -- post once: the like now counts; a second like is a no-op --------------------
    ok((await run(["post", "Hello world #agents"], env)).code === 0, "post exits 0");
    const l2 = await run(["like", POST_A, "--json"], env);
    const j2 = JSON.parse(l2.out);
    ok(l2.code === 0 && j2.liked === true && j2.changed === false && j2.likes === 1 && j2.counts === true, "liking again: changed false, ♥ 1 now that the agent has posted (--json)");
    const l3 = await run(["like", POST_A], env);
    ok(l3.out.includes("already liked") && l3.out.includes("(♥ 1)") && !/count once/.test(l3.out), "already liked -> ♥ 1, no 'counts' line");

    // -- own post is refused by the API, and the CLI says why ------------------------
    const own = await run(["like", POST_C], env);
    ok(own.code === 1 && /does not like its own post/.test(own.err), "liking your own post -> exit 1 with the API's reason");

    // -- search is off (DIVE-6203): a reason, exit 2, and no call to the API --------
    const before = seen.length;
    const s1 = await run(["search", "error", "bars"], env);
    ok(s1.code === 2 && /search is off on a2a/.test(s1.err), "search -> exit 2, 'search is off'");
    const sj = JSON.parse((await run(["search", "eval", "--json"], env)).out);
    ok(sj.ok === false && /search is off/.test(sj.error), "search --json -> ok:false with the reason");
    ok(seen.length === before, "search never calls the API");

    // -- topic -------------------------------------------------------------------------
    const t1 = await run(["topic", "#Evals"], env);
    ok(t1.code === 0 && t1.out.includes("#evals · https://a2a.example/t/evals") && t1.out.includes(POST_A), "topic #Evals -> /a2a/topics/evals with its site link");
    ok(seen.some((x) => x.startsWith("GET /a2a/topics/evals?limit=20&viewer=")), "topic normalizes the tag and sends viewer");
    ok(/No posts under #nothing/.test((await run(["topic", "nothing"], env)).out), "an empty topic says so");
    ok((await run(["topic", "#123"], env)).code === 2, "a tag with no letter -> exit 2");

    // -- unlike ------------------------------------------------------------------------
    const u1 = await run(["unlike", POST_A], env);
    ok(u1.code === 0 && u1.out.includes(`✓ unliked ${POST_A}  (♥ 0)`) && !likes.get(POST_A).has(me), "unlike drops the like: ♥ 0");
    ok((await run(["unlike", POST_A], env)).out.includes("not liked"), "unlike again -> not liked");
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`likes: ${n}/${n} pass`);
})().catch((e) => {
  server.close();
  console.error(e);
  process.exit(1);
});
