"use strict";

// OpenAgent A2A transport seam (DIVE-730) — the ONE place the wire lives.
//
// The handshake (lib/handshake.js) and co-signed receipts (lib/receipts.js) are
// pure crypto: bytes in, bytes out. a2aRouter (lib/a2a-router.js) drives the
// PROTOCOL over those primitives. Everything physical — who carries the bytes —
// hides behind this interface so the same router runs over a loopback (tests),
// the v1 platform's mediated pending-queue, or a future public HTTP /a2a port
// with zero core change.
//
// An A2ATransport is intentionally tiny and identity-BLIND. It moves opaque,
// JSON-serializable messages on a "session" (one logical channel to one peer)
// and never asserts who the peer is — identity is proven by the live handshake
// the router runs ON TOP, not by the transport. That separation is the whole
// point: a compromised or lying transport can drop, reorder, or forge message
// fields, and the router still won't mis-identify a peer (see a2a-router.js,
// which derives peer identity from the handshake, never from a message field).
//
// Interface (duck-typed; no base class to subclass):
//   open(peerRef): string            // initiator: a fresh session id for a peer
//   send(sessionId, message): void   // deliver one opaque message on a session
//   onMessage(handler): void         // handler(sessionId, message) on inbound
//
// The loopback adapter below is the PERMANENT test transport — not throwaway
// scaffolding, but how the router is exercised in-process from here on.

// In-memory loopback: two wired endpoints, each a complete A2ATransport. A
// message sent on one endpoint is delivered to the other's handler on a future
// microtask (async, like a real wire) and is deep-copied first, so the two sides
// share no mutable state — exactly what a serialize -> send -> deserialize hop
// would do. Returns { a, b }, two endpoints wired to each other.
function loopbackPair() {
  const endpoints = {};
  const make = (self, other) => {
    let seq = 0;
    const ep = {
      label: self,
      // The initiator picks the session id; the responder learns it from the
      // first inbound message. Namespaced per endpoint so ids never collide.
      open() {
        return `lb-${self}-${++seq}`;
      },
      send(sessionId, message) {
        const peer = endpoints[other];
        // JSON round-trip = simulate the serialization a real transport forces,
        // so a test can't accidentally pass via a shared object reference.
        const copy = JSON.parse(JSON.stringify(message));
        queueMicrotask(() => {
          if (peer._handler) peer._handler(sessionId, copy);
        });
      },
      onMessage(handler) {
        ep._handler = handler;
      },
      _handler: null,
    };
    return ep;
  };
  endpoints.a = make("a", "b");
  endpoints.b = make("b", "a");
  return endpoints;
}

module.exports = { loopbackPair };
