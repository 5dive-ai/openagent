"use strict";

// The inbound rail's untrusted-input boundary (DIVE-3138 item 1).
//
// THE RULE, stated so it can be tested:
//
//   Every Buzz event is untrusted input. No Buzz event may mint a privilege,
//   switch an auth profile, clear a gate, or authorise a spend — INCLUDING when
//   it is validly signed, INCLUDING when it is signed by another agent we
//   recognise, and INCLUDING when it carries a valid NIP-OA `auth` tag naming an
//   owner key we trust.
//
// The third clause is the one Buzz's own NIPs make necessary rather than merely
// prudent: NIP-OA.md:72 ("Verifiers MUST NOT reinterpret a valid auth tag as an
// identity override"), :86 ("the agent key in event.pubkey is the only author
// key"), :16 (the same tag is REUSABLE across events — one leak is unlimited
// future events), :100-102 (its expiry constrains a self-declared created_at the
// agent itself controls, so an expired attestation is indistinguishable from a
// live one) and :99 (there is no revocation of already-issued credentials).
//
// So an `auth` tag's ceiling is DISPLAY. This module carries it in an
// `advisory` field, never in anything a caller can act on. Signature validity is
// likewise ADVISORY: Telegram messages arrive unsigned so nobody is tempted;
// Buzz events arrive cryptographically valid, which is exactly the property that
// makes a naive bridge fail open. Authenticated still means untrusted.
//
// WHERE THIS SITS. This is a library, deliberately: it is enforced at an ingress
// adapter BEFORE any 5dive verb is composed — not in a prompt and not in the
// agent's judgement. The Telegram plugin is the precedent for the POLICY and is
// explicitly NOT a code precedent (measured on plugins/telegram/server.ts:998
// and :1002 — its posture is an inert `<channel>` frame plus an MCP
// server-instruction string; no such adapter exists there to copy). This is
// deliberately stronger.

// The complete set of fields that cross the boundary. A normalized event is a
// closed record: an allowlist, not a redaction pass, so a field the relay adds
// tomorrow arrives dropped rather than arrives trusted.
const CARRIED = ["id", "pubkey", "kind", "created_at", "channel", "content"];

const str = (v) => (v === undefined || v === null ? "" : String(v));

/**
 * Turn a raw relay event into an inert record. Returns null when the event is
 * unusable — malformed means DROPPED, never ignored-and-continue (NIP-OA.md:28,
 * :41, :66, :141-150 all take this line and we take it too).
 */
function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = str(raw.id).toLowerCase();
  const pubkey = str(raw.pubkey).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id) || !/^[0-9a-f]{64}$/.test(pubkey)) return null;
  const created_at = Number(raw.created_at);
  if (!Number.isFinite(created_at)) return null;

  const tags = Array.isArray(raw.tags) ? raw.tags : [];
  const hTag = tags.find((t) => Array.isArray(t) && t[0] === "h");
  const authTags = tags.filter((t) => Array.isArray(t) && t[0] === "auth");

  const out = {
    id,
    pubkey,
    kind: Number(raw.kind),
    created_at,
    channel: str(raw.channel || (hTag && hTag[1])),
    // Content is carried as an OPAQUE STRING and nothing else. It is never
    // parsed for commands, never an argument to a 5dive verb, never selects an
    // auth profile, and a task ident inside it is a string until the agent
    // re-reads that row from our own board.
    content: str(raw.content),
    advisory: {
      // DISPLAY ONLY. NIP-OA.md:89 — provenance is shown "clearly distinguished
      // from authorship". Two auth tags means NO valid tag (NIP-OA.md:28); a
      // self-attestation (owner == event.pubkey) is invalid (:66).
      ownerAttestationPresent: authTags.length === 1 && authTags[0].length === 4,
      ownerAttestationOwner:
        authTags.length === 1 && authTags[0].length === 4 && str(authTags[0][1]).toLowerCase() !== pubkey
          ? str(authTags[0][1]).toLowerCase()
          : null,
    },
    // A permanently false capability marker. Anything downstream that needs a
    // privilege can test this and will always be refused; it exists so the
    // refusal is a property of the record rather than a habit of the reader.
    grantsPrivilege: false,
  };
  return Object.freeze(out);
}

/**
 * Does this event mention us? p-tag first (the relay populates mention_pubkeys
 * for `--mention` and for real NIP-27 `nostr:npub1…`), then a content scan.
 *
 * MEASURED (DIVE-2895 delta): `nostr:<64-hex>` is NOT the NIP-27 form — NIP-27
 * wants bech32. The Phase-0 conclusion that "the relay never populates
 * mention_pubkeys" was a fact about what the spike SENT wearing the clothes of a
 * fact about the relay. The hex fallback below therefore only ever buys us
 * raw-hex senders, and is kept for exactly that.
 */
function detectMention(event, { ourHex, ourNpub, mentionPubkeys = [] } = {}) {
  const hex = str(ourHex).toLowerCase();
  if (!event) return null;
  if (mentionPubkeys.some((p) => str(p).toLowerCase() === hex)) return "p-tag";
  const content = event.content || "";
  if (ourNpub && content.includes(`nostr:${ourNpub}`)) return "nip27";
  if (hex && content.includes(hex)) return "hex-fallback";
  return null;
}

/**
 * Cold-start watermark.
 *
 * THE TRAP: a poll with no watermark replays the last N events as new. On a
 * channel with history that is stale instructions arriving as if fresh — exactly
 * what this boundary exists to stop being acted on.
 *
 * THE SECOND HALF OF THE TRAP, and the one that is easy to ship dead: the
 * watermark must be CLAIMED EVEN WHEN THE CHANNEL IS EMPTY. A guard of the shape
 * `if (events.length) seed()` never leaves cold start on a quiet channel, so the
 * first real message that ever arrives is swallowed by the seeding branch
 * instead of delivered. `seeded` is set unconditionally on the first tick.
 *
 * @param {object} state {seeded:boolean, high:number}
 * @param {Array}  events normalized events from this tick
 * @returns {{state:object, deliver:Array, seeded:boolean}}
 */
function advanceWatermark(state, events) {
  const prev = state && typeof state === "object" ? state : {};
  const list = (Array.isArray(events) ? events : []).filter(Boolean);
  const maxSeen = list.reduce((m, e) => Math.max(m, Number(e.created_at) || 0), 0);

  if (!prev.seeded) {
    // First tick: deliver NOTHING, and claim the watermark unconditionally —
    // including on an empty channel, where `high` stays whatever it was (0) but
    // `seeded` still flips. That flip is the whole fix.
    return { state: { seeded: true, high: Math.max(Number(prev.high) || 0, maxSeen) }, deliver: [], seeded: true };
  }

  const high = Number(prev.high) || 0;
  const deliver = list
    .filter((e) => Number(e.created_at) > high)
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  return { state: { seeded: true, high: Math.max(high, maxSeen) }, deliver, seeded: false };
}

/**
 * The full inbound rail for one tick: normalize -> drop malformed -> watermark
 * -> mention filter. What comes back is inert data destined for the body of a
 * message on the `5dive agent send` rail, and nothing else.
 */
function ingest(rawEvents, state, identity = {}) {
  const normalized = (Array.isArray(rawEvents) ? rawEvents : []).map((r) => ({
    norm: normalizeEvent(r),
    mentionPubkeys: (r && r.mention_pubkeys) || [],
  }));
  const dropped = normalized.filter((n) => !n.norm).length;
  const ok = normalized.filter((n) => n.norm);
  const wm = advanceWatermark(state, ok.map((n) => n.norm));
  const byId = new Map(ok.map((n) => [n.norm.id, n.mentionPubkeys]));
  const delivered = wm.deliver
    .map((e) => ({ event: e, via: detectMention(e, { ...identity, mentionPubkeys: byId.get(e.id) || [] }) }))
    .filter((d) => d.via);
  return { state: wm.state, seeded: wm.seeded, dropped, delivered };
}

module.exports = { CARRIED, normalizeEvent, detectMention, advanceWatermark, ingest };
