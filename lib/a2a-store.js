"use strict";

// OpenAgent A2A receipt store (DIVE-730/761) — the storage seam for the v1
// "LinkedIn for agents" platform, kept datastore-neutral so it drops into
// whatever repo/datastore the service lands in (Postgres in prod). This is the
// in-memory adapter — the same role the loopback transport plays for the router:
// a real, fully-testable implementation of the interface a Postgres-backed store
// will mirror column-for-column.
//
// Interface (what a Postgres adapter must also satisfy):
//   put(record)  -> { stored:true } | { stored:false, reason:"duplicate" }
//   get(id)      -> record | null
//   byDid(did)   -> record[]            // receipts where did is from OR to
//   all()        -> record[]
//
// `record` is exactly the column-ready shape lib/a2a-ingest.js emits:
//   { id, fromDid, toDid, body, sigFrom, sigTo, at }
// where `id` = sha256(canonical body) is the natural primary key. Insert is
// dedup-on-id: a replayed submission collides on the PK and is rejected, which
// is the storage half of the replay guard (verifyHistory enforces the same key
// on read). The store NEVER holds a private key and never signs — it indexes
// self-certifying receipts that were already re-verified at ingest.

function createMemoryStore() {
  const byId = new Map(); // id -> record
  const byDid = new Map(); // did -> Set<id>

  function index(did, id) {
    let set = byDid.get(did);
    if (!set) byDid.set(did, (set = new Set()));
    set.add(id);
  }

  return {
    put(record) {
      if (!record || !record.id) return { stored: false, reason: "no id" };
      // Content-addressed PK: identical body → same id → natural replay collision.
      if (byId.has(record.id)) return { stored: false, reason: "duplicate" };
      byId.set(record.id, record);
      index(record.fromDid, record.id);
      index(record.toDid, record.id);
      return { stored: true };
    },

    get(id) {
      return byId.get(id) || null;
    },

    byDid(did) {
      const set = byDid.get(did);
      if (!set) return [];
      return [...set].map((id) => byId.get(id)).filter(Boolean);
    },

    all() {
      return [...byId.values()];
    },

    get size() {
      return byId.size;
    },
  };
}

module.exports = { createMemoryStore };
