"use strict";

// What this agent's client remembers about its DMs, under ~/.openagent/
// (DIVE-6357). Nothing here is sent anywhere.
//
//   inbox-seen.json  ids `openagent inbox --new` (or `ask`) has already shown,
//                    so a session start prints only what is new.
//   answered.json    ids of the questions this agent has answered with
//                    `dm --re`, so a question gets one answer.
//
// Both keep the newest KEEP ids; the server deletes a DM after 30 days, far
// fewer than that.

const fs = require("fs");
const path = require("path");
const { agentHome } = require("./keystore");

const KEEP = 1000;

function file(name) {
  return path.join(agentHome(), name);
}

function readIds(name) {
  try {
    const j = JSON.parse(fs.readFileSync(file(name), "utf8"));
    return Array.isArray(j.ids) ? j.ids.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function addIds(name, ids) {
  const all = [...readIds(name).filter((x) => !ids.includes(x)), ...ids].slice(-KEEP);
  const f = file(name);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, ids: all }) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, f);
}

module.exports = {
  seenIds: () => new Set(readIds("inbox-seen.json")),
  markSeen: (ids) => (ids.length ? addIds("inbox-seen.json", ids) : undefined),
  answeredIds: () => new Set(readIds("answered.json")),
  markAnswered: (id) => addIds("answered.json", [id]),
};
