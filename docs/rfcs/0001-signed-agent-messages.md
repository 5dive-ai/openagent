---
rfc: 0001
title: Signed agent messages — an agent's home inbox, and proof of who is writing to it
status: draft        # draft | accepted | rejected | postponed
spec_target: 0.3    # a companion format plus one optional persona field
author: 5dive (main)
created: 2026-09-25
---

# RFC 0001: Signed agent messages

## Summary

Every agent gets a home address, an **inbox** URL on the machine it runs on,
published in its signed persona. Another agent can then message it directly,
with no chat platform, bot or connector in between. A direct web request carries
no sender identity, so each message is signed with the sender's OpenAgent key
(the ed25519 key behind its `did:key` address). The receiver delivers a message
only if the sender is on its own **contact list** (did:key addresses its owner
added). Everything else is dropped. A valid signature proves **who** sent a
message, never **what they are allowed to ask for**.

Channels that already authenticate the sender (a Telegram account, a GitHub
login, a Nostr key, a mail domain) are out of scope. A runtime can map those
identities to contacts directly, and signing on top of them adds nothing.

## Motivation

Agents on different machines, owned by different people, already work on the
same things. One agent reports defects, another files and grades the fixes. Today
every exchange between them goes through a human who copies text from one chat
to the other.

The usual fix is to put both agents in a shared chat. That works, but every
channel needs its own connector, and the conversation lives on someone else's
platform. Most agents that would use this already run on a machine with its own
domain and TLS certificate, so they could simply post to each other.

What a direct request lacks is identity. Telegram, GitHub, email and Nostr
each tell the receiver who sent a message. An HTTPS `POST` from an unknown
address tells it nothing. The signature supplies exactly that, and only on this
path, where nothing else does.

Every OpenAgent already has an ed25519 key and a `did:key` address
(`openagent keygen` / `address`). The missing pieces are an inbox address, a
message format, and a rule for what the receiver does. This belongs in the spec
rather than in one tool because both ends must agree on the exact bytes that are
signed and on where the inbox is published.

## Proposal

### 1. The envelope

```json
{
  "openagent_msg": "0.1",
  "id": "01J8ZK3V7Q9M2X4T6B8N0C1D2E",
  "from": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
  "to": ["did:key:z6MkjchhfUsD6mmvni8mCdXHw216Xrm9bQe2mBH1P5RDjVJG"],
  "at": "2026-09-25T10:08:00Z",
  "expires": "2026-09-26T10:08:00Z",
  "thread": "01J8ZJ9A0000000000000000AA",
  "ref": "DIVE-4983",
  "body": "The wait-for fix is on the PR. Ready to grade.",
  "sig": "<base64 ed25519 signature>"
}
```

| field | req | meaning |
|---|---|---|
| `openagent_msg` | ✓ | envelope version, `"0.1"` |
| `id` | ✓ | unique per message (ULID recommended); used for dedupe and replies |
| `from` | ✓ | sender's `did:key`; its public key verifies `sig` |
| `to` | ✓ | one or more recipient `did:key`s. A receiver not listed ignores the message. |
| `at` | ✓ | send time, UTC ISO 8601 |
| `expires` | – | after this time the message is ignored. Default: `at` + 24h. A receiver clamps it to at most `at` + 7 days, so a sender cannot make the seen-id cache grow without bound. |
| `thread` | – | the `id` this replies to |
| `ref` | – | opaque label the two sides agree on (a task id, a PR URL) |
| `body` | ✓ | plain text, at most 16 KiB |
| `sig` | ✓ | detached ed25519 signature, base64 |

**Signing.** Like `provenance`, the signature is over the *canonical* envelope:
`sig` removed, then serialised with the JSON Canonicalization Scheme (**RFC 8785, JCS**).
"Sorted keys, no whitespace" alone leaves number formatting and Unicode escaping open,
and the two ends would disagree about the signed bytes.
Those bytes are prefixed with the domain separator
`openagent:msg:v0.1\n`. The separator stops a message signature from being
replayed as a persona `provenance` signature or as a Buzz binding statement, and
the reverse. The public key is decoded from `from`
(`did:key:z` + base58btc(`0xed01` ‖ key)). No key needs to be fetched.

**On the wire.** The envelope is the JSON body of the `POST`, with
`Content-Type: application/openagent-msg+json`.

### 2. The contact list (the receiver's trust root)

Each receiving runtime keeps a contact list: `did:key` → display name, where the
agent lives, who added it and when. **Only the receiving side's owner can add a
contact.** That means a dashboard or root action, never a message, just as a
chat bot's pairing cannot be approved from inside the chat. Owners exchange
addresses out of band, or read them from each other's signed persona files
(`openagent address <file>`).

### 3. What a receiver does

1. Refuse anything over 64 KiB, then rate-limit by source address. Parse and check
   the version. **Look up `from` in the contact list before verifying the signature**,
   so a stranger's message costs no crypto. An unknown sender is dropped here, and so is
   any other failure in steps 1 and 2: the answer is always `202` and nothing reaches the
   agent. The inbox is not a public comment box.
2. Verify `sig` against `from`. Check that `to` contains the receiver, that `at` is within
   10 minutes of the receiver's clock, that the message has not expired (after the clamp
   above), and that `id` has not been seen before (keep seen ids until they expire). A
   clock-skew refusal is logged for the owner, but only once the signature has verified.
3. **Only now, with the sender proven,** apply the contact's own limits: a rate limit and
   a cap on waiting messages, counted on VERIFIED messages only. `from` is chosen by the
   sender and every did:key is public, so counting unverified messages would let a
   stranger burn a real contact's quota. This is the only place a `429` may be sent.
   Sending one earlier would tell a stranger which `from` values are contacts.
4. Deliver it as a teammate message, marked with the contact's name and a short form of
   the address. **The body is external, untrusted text from a verified sender**, and it
   is never delivered with elevated privileges. On a 5dive box this is an ordinary
   `5dive agent send` on the existing agent-to-agent rail, so that rail's round limits,
   credential guard and audit trail apply unchanged.
5. **Authority does not travel with identity.** A verified message from a contact
   is a request from a teammate. It cannot answer a human approval, approve a
   purchase or send, change a setting, or unlock anything its owner's rules keep
   locked. The receiver's own rules decide what a teammate may ask for.

### 4. Keys stay out of the model's reach

The private key is created when the agent is created. It is readable only by the
runtime (on 5dive: root, mode 0600) and never enters the agent's context. The
agent asks the runtime to sign (`sudo 5dive peer send <contact> "<text>"` on 5dive).
It never holds the key. An agent that could read its own key could be talked
into leaking it. The runtime takes the signing agent from the caller's authenticated
identity (on 5dive, `SUDO_USER`), **never from an argument**. Where an agent's
own privileges already reach the key store, this is a policy and not a boundary, and
the runtime should say so.

### 5. Where an agent lives: its inbox

"I know where it lives, and if it knows me it gets my message." An agent says
where to reach it with one new optional persona field, `links.inbox`, a URL.
Because it sits inside the signed persona, a third party cannot swap it: anyone
who has the card can check that the address was published by the key holder.

```yaml
links:
  agent_card: https://box.example.com/.well-known/agent-card.json
  inbox: https://box.example.com/openagent/inbox
```

**Direct (the default).** The sender's runtime signs the envelope and
`POST`s it to the recipient's inbox over HTTPS. The inbox runs the checks in §3.
It answers `202 Accepted` whether or not the sender is a contact, so a stranger
cannot probe someone's contact list. A 5dive box already has its own domain and
TLS certificate, so its inbox is `https://<box-domain>/openagent/inbox` and
needs no new infrastructure. A reply is a `POST` to the sender's inbox, with
`thread` set.

**Relay (only for agents that cannot open a port).** `links.inbox` points at a
store-and-forward mailbox, `https://relay.example/inbox/<did>`, and the agent
polls it. The relay carries no identity of its own, which is why the signature
matters there as well. A relay cannot forge a message. It can read, delay or
drop one, since v0.1 does not encrypt. Anyone can run a relay, and none is
privileged.

### 5a. Human-readable addresses

An agent may also be named `name@domain`, like an email address. It resolves to the
signed persona at `https://<domain>/openagent/agents/<name>.json`, whose
`provenance.created_by.key` gives the did:key and whose `links.inbox` gives the inbox.
The did:key stays the identity. On the first lookup the resolver pins the did:key. If a
later lookup returns a different key, messages are refused until the owner confirms.
A domain can therefore move an agent but cannot silently swap it.

The card need not be a full persona. A minimal document with `id` (`name@domain`), `name`,
`links.inbox` and a `provenance` signature is enough, and `openagent verify` reads it like any
signed persona.

### Where this sits

A2A (Agent2Agent) standardises what an agent can do and how to call it.
`links.agent_card` already points to that. This RFC adds the missing half for a
direct call: proof of who is calling. A runtime can serve both on the same box.
Agents that meet on an authenticated channel (for example Buzz, whose `npub` is
already bound to a did:key) keep using that channel's identity.

## Reference implementation

[`5dive-ai/5dive-a2a`](https://github.com/5dive-ai/5dive-a2a) implements this draft for 5dive boxes
(the `5dive peer` command): the envelope, RFC 8785 signing with the domain separator, the
receiver's check order in §3, pinned `name@domain` cards, and every conformance case below as a
test. Its cards verify with this repo's `lib/provenance.js`.

## Compatibility

This adds a new document type and one optional persona field, `links.inbox`.
Every existing file stays valid. A persona's existing `provenance.created_by.key` is
the key an agent signs messages with, so no new key material is needed for
agents that already sign their card.

## Conformance

New `conformance/messages/` cases, run by `openagent msg verify`:

- valid: a signed envelope verifies, and so does the same envelope with its keys reordered;
- invalid: one body byte changed; `sig` from a different key; the message
  signed without the domain separator; a persona `provenance` signature
  presented as a message signature; `to` not including the verifier;
  expired; `at` 11 minutes ahead; a replayed `id`.

CLI: `openagent msg sign --key <priv> --to <did> "<text>"` prints the signed
envelope, and `openagent msg send <did|inbox-url> …` posts it. `openagent msg verify <envelope.json> [--me <did>] [--contacts <file>]` prints the
decoded envelope, the verdict and, when a contact list is given, the contact.

## Alternatives considered

- **Sign every message on every channel** (this RFC's first draft). Rejected:
  Telegram, GitHub, email and Nostr already authenticate the sender, so a second
  signature there verifies identity twice and needs a connector per channel.
  The signature is kept only where nothing else carries identity.
- **One mandatory relay.** Rejected: whoever runs it would become the network's
  gatekeeper. Direct delivery is the default. Relays are a fallback for agents
  that cannot open a port.
- **Encrypt as well as sign.** Deferred. v0.1 is signed, not encrypted, so the
  body must not carry secrets. Encryption to the recipient's key is a natural
  v0.2 on top of the same envelope.
- **Carry authority in the message** (a signed "my owner approves X"). Deferred.
  Identity first. Owner-signed approvals would be a separate, later RFC.

## Unresolved questions

- One key per agent, or one per runtime that vouches for its agents? This draft
  uses one per agent, because the persona already has it.
- Revocation: removing a contact is local and immediate. A compromised key needs
  the rotatable root anchor from the identity work before others can learn of
  it.
- Group messages: several `to` entries in one envelope, or one envelope each?
- ~~Clock skew: is 10 minutes enough?~~ Yes with NTP (review, 2026-09-25). A skew
  refusal is logged for the owner after the signature check.
- Files: v0.1 carries links only, but a runtime's files are usually private. Should v0.2
  define an expiring signed URL, or an inbox-served attachment for contacts?
