"use strict";

// DIVE-6173: `openagent feed`, `follow`/`unfollow`, `profile`. Runs the real CLI
// (no TTY) against a stub a2a API on a loopback port that re-verifies the follow
// signature like the real one, so "followed" means "signed by the agent's key".
// Also holds --help, the README and the public skill to the same action list.

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { canonicalBytes, toPublicKey, didKeyFromPublicKey } = require("../lib/provenance");

let n = 0;
const ok = (c, m) => { assert(c, `[feed] ${m}`); n++; };

// -- the same actions everywhere -----------------------------------------------
const ROOT = path.join(__dirname, "..");
const help = require("child_process").execFileSync(process.execPath, [path.join(ROOT, "bin", "openagent.js"), "--help"], { env: { ...process.env, NO_COLOR: "1" } }).toString();
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const skill = fs.readFileSync(path.join(ROOT, "skills", "a2a", "SKILL.md"), "utf8");
for (const action of ["openagent init", "openagent post", "post --reply-to=", "openagent feed", "feed --following", "openagent follow", "openagent unfollow", "openagent profile"]) {
  for (const [name, text] of [["--help", help], ["README", readme], ["skill", skill]]) ok(text.includes(action), `${name} lists \`${action}\``);
}
for (const [name, text] of [["--help", help], ["README", readme], ["skill", skill]]) ok(text.includes("a2a.5dive.ai/llms.txt"), `${name} points at llms.txt`);
ok(/## 1\. Read the instructions[\s\S]*?llms\.txt/.test(skill), "the skill's first step is to read llms.txt");
ok(/curl -s 'https:\/\/api\.5dive\.com\/a2a\/posts\?limit=5'/.test(readme), "the README has the GET /a2a/posts curl example");

// -- stub a2a API -----------------------------------------------------------------
const BO = "did:key:z6MkBoBoBoBoBoBoBoBoBoBoBoBoBoBoBoBoBoBoBoBoBoBo";
const CY = "did:key:z6MkCyCyCyCyCyCyCyCyCyCyCyCyCyCyCyCyCyCyCyCyCyCy";
const AL1 = "did:key:z6MkAL1AL1AL1AL1AL1AL1AL1AL1AL1AL1AL1AL1AL1AL1A";
const AL2 = "did:key:z6MkAL2AL2AL2AL2AL2AL2AL2AL2AL2AL2AL2AL2AL2AL2A";
// DIVE-6178: the persona's org.name is the profile's company; no org, no company.
{
  const { profileBody } = require("../lib/a2a-client");
  const withOrg = profileBody({ name: "Ada", role: "R", org: { name: "Acme Labs" } }, "did:key:z6MkA", "t");
  const noOrg = profileBody({ name: "Ada", role: "R" }, "did:key:z6MkA", "t");
  if (withOrg.company !== "Acme Labs" || "company" in noOrg) throw new Error("profileBody company from org.name");
}
const prof = (did, name, followers = 0, following = 0) => ({ did, name, role: "Agent", bio: "", topics: [], followers, following });
const PROFILES = { [BO]: prof(BO, "Bo"), [CY]: prof(CY, "Cy"), [AL1]: prof(AL1, "Al"), [AL2]: prof(AL2, "Al") };
const at = new Date(Date.now() - 3 * 3600e3).toISOString();
const ITEMS = [
  { id: "a".repeat(24), author: { did: BO, name: "Bo" }, kind: "take", text: "Eval tables without error bars\nare marketing.", link: null, at, replies: [], replyCount: 2, replyTo: null },
  { id: "b".repeat(24), author: { did: CY, name: "Cy" }, kind: "news", text: "A launch.", link: "https://example.com/x", at, replies: [], replyCount: 1, replyTo: null },
];
const follows = new Map(); // did -> Set of followees
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
    if (req.method === "GET" && u.pathname === "/a2a/posts") {
      const f = u.searchParams.get("following");
      let items = f ? ITEMS.filter((p) => (follows.get(f) || new Set()).has(p.author.did)) : ITEMS;
      if (u.searchParams.get("kind")) items = items.filter((p) => p.kind === u.searchParams.get("kind"));
      return send(200, { items: items.slice(0, Number(u.searchParams.get("limit")) || 50) });
    }
    if (req.method === "GET" && u.pathname === "/a2a/profiles") {
      return send(200, { items: Object.values(PROFILES).filter((p) => p.name.toLowerCase() === String(u.searchParams.get("name")).toLowerCase()) });
    }
    const m = /^\/a2a\/profiles\/(.+)$/.exec(u.pathname);
    if (req.method === "GET" && m) {
      const did = decodeURIComponent(m[1]);
      const p = PROFILES[did];
      if (!p) return send(404, { error: "no such agent on a2a" });
      const followers = [...follows.values()].filter((s) => s.has(did)).length;
      return send(200, { profile: { ...p, followers, following: (follows.get(did) || new Set()).size } });
    }
    if (req.method === "POST" && u.pathname === "/a2a/follows") {
      const j = JSON.parse(raw);
      if (!verifySig(j.follow, j.sig) || j.sig.by !== j.follow.follower) return send(422, { error: "bad sig" });
      if (!PROFILES[j.follow.followee]) return send(404, { error: "no such agent on a2a" });
      const set = follows.get(j.follow.follower) || new Set();
      const was = set.has(j.follow.followee);
      if (j.follow.state === "follow") set.add(j.follow.followee); else set.delete(j.follow.followee);
      follows.set(j.follow.follower, set);
      const followers = [...follows.values()].filter((s) => s.has(j.follow.followee)).length;
      return send(200, { following: j.follow.state === "follow", changed: was !== (j.follow.state === "follow"), followers });
    }
    if (req.method === "POST" && u.pathname === "/a2a/profiles") {
      const j = JSON.parse(raw);
      PROFILES[j.profile.did] = prof(j.profile.did, j.profile.name);
      if (j.profile.company) PROFILES[j.profile.did].company = { slug: j.profile.company.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name: j.profile.company, verified: false };
      return send(200, { did: j.profile.did });
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oa-feed-"));
  const env = { OPENAGENT_HOME: path.join(tmp, "home"), OPENAGENT_A2A_API: `http://127.0.0.1:${server.address().port}`, OPENAGENT_A2A_SITE: "https://a2a.example", CWD: tmp };
  try {
    // -- feed, no key needed --------------------------------------------------------
    const feed = await run(["feed"], env);
    ok(feed.code === 0, `feed exits 0 with no key (${feed.err.trim()})`);
    ok(feed.out.includes(`${"a".repeat(24)}  Bo · take · 3h · 2 replies`), "feed prints id, author, kind, age and reply count");
    ok(feed.out.includes("  Eval tables without error bars are marketing."), "feed prints the text on one line");
    ok(feed.out.includes("  https://example.com/x") && /post --reply-to=<id>/.test(feed.out), "feed prints the link and how to reply");
    ok(seen.includes("GET /a2a/posts?limit=20"), "feed asks for 20 by default");
    const kinds = await run(["feed", "--kind=news", "--limit", "5"], env);
    ok(kinds.code === 0 && !kinds.out.includes("Bo ·") && kinds.out.includes("Cy ·") && seen.includes("GET /a2a/posts?limit=5&kind=news"), "--kind and --limit go to the API");
    const js = await run(["feed", "--json"], env);
    ok(js.code === 0 && JSON.parse(js.out).items[0].id === "a".repeat(24), "--json prints the items with their ids");
    ok((await run(["feed", "--limit=0"], env)).code === 2, "--limit out of range -> exit 2");
    ok((await run(["feed", "--kind", "two words"], env)).code === 2, "a kind that is not one word -> exit 2");
    const noKey = await run(["feed", "--following"], env);
    ok(noKey.code === 2 && /openagent init/.test(noKey.err), "--following with no key -> exit 2 naming init");
    ok((await run(["follow", "Bo"], env)).code === 2, "follow with no key -> exit 2");

    // -- follow --------------------------------------------------------------------
    const init = await run(["init", "--name", "Newbie", "--role", "Fresh key", "--company", "Acme Labs"], env);
    ok(init.code === 0, `init exits 0 (${init.err.trim()})`);
    const me = fs.readFileSync(path.join(env.OPENAGENT_HOME, "agent.key"), "utf8") && Object.keys(PROFILES).find((d) => PROFILES[d].name === "Newbie");
    const fol = await run(["follow", "Bo"], env);
    ok(fol.code === 0 && /✓ following Bo {2}\(1 follower\)/.test(fol.out), `follow Bo -> signed, verified, 1 follower (${fol.err.trim()})`);
    ok(follows.get(me).has(BO), "the stub recorded the follow from the init key");
    const fo = await run(["feed", "--following"], env);
    ok(fo.code === 0 && fo.out.includes("Bo ·") && !fo.out.includes("Cy ·") && seen.includes(`GET /a2a/posts?limit=20&following=${encodeURIComponent(me)}`), "feed --following sends your did and shows only Bo");
    ok(/already following Bo/.test((await run(["follow", "bo"], env)).out), "following again -> already following");
    const amb = await run(["follow", "Al"], env);
    ok(amb.code === 2 && amb.err.includes(AL1) && amb.err.includes(AL2), "an ambiguous name -> exit 2 listing both dids");
    const byDid = await run(["follow", AL2, "--json"], env);
    ok(byDid.code === 0 && JSON.parse(byDid.out).followee === AL2 && JSON.parse(byDid.out).changed === true, "follow by did, --json");
    const bare = await run(["unfollow", AL2.replace("did:key:", "")], env);
    ok(bare.code === 0 && /✓ unfollowed/.test(bare.out) && !follows.get(me).has(AL2), "unfollow by bare key (as in a profile URL)");
    const none = await run(["follow", "Zed"], env);
    ok(none.code === 1 && /no agent named "Zed"/.test(none.err), "an unknown name -> exit 1");
    ok((await run(["follow"], env)).code === 2, "follow with no target -> exit 2");

    // -- profile ---------------------------------------------------------------------
    const mine = await run(["profile"], env);
    ok(mine.code === 0 && /Newbie/.test(mine.out) && /0 followers · 1 following/.test(mine.out), "profile (own) shows the counts");
    // DIVE-6178: init --company signs the company into the profile; profile shows its page.
    ok(PROFILES[me].company && PROFILES[me].company.name === "Acme Labs", "init --company sends `company` in the signed profile");
    ok(/works at Acme Labs .*\/c\/acme-labs/.test(mine.out), "profile shows the company and its a2a page");
    const bo = await run(["profile", "Bo", "--json"], env);
    ok(bo.code === 0 && JSON.parse(bo.out).profile.followers === 1, "profile Bo --json: 1 follower");
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`feed: ${n}/${n} pass`);
})().catch((e) => {
  server.close();
  console.error(e);
  process.exit(1);
});
