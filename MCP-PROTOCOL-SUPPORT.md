# MCP protocol support

**Latch speaks Model Context Protocol revision `2025-06-18`, as a client only.**

Recorded 2026-08-15. See [MCP.md](./MCP.md) for what the host-brokered MCP integration *is*; this file
records which revision of the protocol it speaks and what that deliberately excludes.

It exists because a version constant with nothing written around it is a claim nobody can check. Latch
announced `2025-06-18` in `initialize` and then ignored whatever the server answered — so a server
replying with a revision Latch has never implemented was treated as agreement, and the host went on to
broker credential-bearing tool calls over a wire format it could not actually speak.

If you change `SUPPORTED_PROTOCOL_VERSIONS` in `mcp.mjs`, change this file in the same commit.

## Which role Latch plays

Latch is an MCP **client/host**. It connects *out* to MCP servers over stdio, holds their credentials,
and runs approved tool calls on the worker's behalf. There is no MCP server endpoint anywhere in Latch —
`/api/mcp/servers` is Latch's own REST API for listing configured servers, not an MCP surface. Nothing
outside Latch can speak MCP *to* it.

That asymmetry is why this file's scope differs from Bureau's: Bureau's `MCP-PROTOCOL-SUPPORT.md` covers
a server, this one covers a client, and the two halves of version negotiation land differently.

| Revision | Era | Latch |
| --- | --- | --- |
| `2025-06-18` | legacy (`initialize` handshake) | **implemented**, client side |
| `2025-11-25` | legacy | not implemented |
| `2026-07-28` | modern (per-request `_meta`) | not implemented |

"Legacy" and "modern" are the `2026-07-28` spec's own terms. Latch is a legacy-era client.

## What the handshake does

Latch announces `2025-06-18`, and now **reads the answer**. The spec puts this decision on the client:

> If the client does not support the version in the server's response, it SHOULD disconnect.

— MCP `2025-06-18`, Lifecycle / Version Negotiation. The server is entitled to answer with a revision
Latch did not ask for, and until now Latch would have carried on regardless. It now refuses: the
connection is torn down (stdin closed, child killed — the stdio shutdown the spec describes) and the
operator gets an error naming both the revision the server chose and the one Latch speaks.

Refusing matters more here than in a general-purpose client. Every op on that connection is a
credential-bearing tool call that a human approved *on the understanding that the host could talk to the
server*. Proceeding on a guessed protocol would turn an approval for one thing into an attempt at
another.

A server that announces no version at all is refused too. Absent is not the same as compatible.

### Modern servers fail loudly rather than silently

A `2026-07-28` server has no `initialize` at all and rejects Latch's handshake outright. Nothing can be
done about that from the client side — a legacy client has no fall-forward mechanism — but the spec asks
such a server to name the versions it *does* support in that error, precisely because for a legacy client
that message may be the only diagnostic available. Latch now carries `error.data.supported` through into
the operator-visible message instead of dropping it, so the failure says what to do about it.

## Why `2026-07-28` is not being implemented

It is a rewrite of the transport contract, not a version bump. It removes `initialize`,
`notifications/initialized`, protocol-level sessions and `Mcp-Session-Id`; it requires a `server/discover`
RPC, a mandatory `resultType` on every result, `_meta` parsing on every request, `Mcp-Method` / `Mcp-Name`
transport headers, `ttlMs` + `cacheScope` on list and read results, Tasks as a polled extension, and
Multi Round-Trip Requests in place of persistent channels for elicitation and sampling.

Latch's MCP client is an ephemeral stdio spawn — connect, handshake, one operation, shut down — built on
Node built-ins with no dependencies. Most of that machinery has no counterpart in it. Doing the work
halfway would recreate exactly the defect this file was written to close, at greater cost.

The trigger to revisit is a server Latch needs that is modern-only. The `2026-07-28` compatibility matrix
is blunt about the outcome until then: a legacy client and a modern server simply fail.

## Known gaps within `2025-06-18`

- **stdio only.** No Streamable HTTP transport, so the `MCP-Protocol-Version` header rules do not apply
  to Latch today. They would the moment an HTTP transport is added.
- **The supported list holds one entry.** Older revisions may well be wire-compatible with the tools-only
  subset Latch uses, but nobody has verified it, so nothing claims it. Widening the list is a deliberate
  act with a check attached.
- **No client capabilities are advertised.** Latch sends `capabilities: {}` — no roots, no sampling, no
  elicitation. Correct today, and the thing that would change first if the opportunity below is taken.

---

## Opportunity: URL-mode elicitation is a description of what Latch already does

Recorded as an opportunity, not a plan. Nothing here is built.

Revision `2025-11-25` added a second elicitation mode. Alongside form mode — structured data collected
in-band through the client — there is **URL mode**, where a server pauses mid-request and directs the
user to an external URL for interactions that must not pass through the MCP client at all. The spec is
explicit that servers **must not** use form mode for secrets, and **must** use URL mode for them: API
keys, OAuth flows to third-party services, payment setup.

The stated security property is the one Latch was built around. From the spec's own summary of the
pattern: the server sends the user to a page on a domain they trust, the user enters the credential
there, the server stores it bound to their identity, and later requests use it — so the secret never
passes through the LLM context, the MCP client, or any intermediate server.

That is Latch's trust boundary, written into the protocol by someone else.

### The shape of it

Latch is a client today. Taking this would mean adding an MCP **server** surface — the role it does not
currently play — that exposes brokered capabilities as tools. When a tool needs a credential or a human
decision, Latch answers with a URL-mode elicitation pointing at its own approval UI. The human approves
in Latch, where they already do. The calling agent gets a result and never sees the credential.

The payoff is reach. Latch's approval boundary currently protects the workers Latch itself runs, plus
Bureau. Spoken natively, it would be an approval surface for **any** MCP client — the same boundary,
offered to agents Latch does not own and did not write.

### What makes it hard, stated up front so it is not discovered later

- **It requires the modern era.** URL-mode elicitation is delivered inside an `InputRequiredResult` via
  Multi Round-Trip Requests. That is the `2026-07-28` machinery this document just declined. The
  opportunity and the rewrite are the same piece of work; they cannot be separated.
- **The phishing attack is the whole problem.** An elicitation URL can be forwarded to someone else. The
  spec requires the server to verify that the user who *opens* the URL is the user the elicitation was
  *generated for*, or the third-party tokens end up bound to the wrong identity — an account takeover.
  Latch's current model is a single operator on a tailnet; multi-user identity binding does not exist yet
  and is the substantive engineering here.
- **Related requirements** that would need honouring: no sensitive data in the URL, no pre-authenticated
  URLs, and the server owns storage and lifecycle of any third-party tokens obtained this way.

### Why record it rather than build it

The MCP ecosystem is converging on a mechanism whose security argument Latch already makes in prose. If
that mechanism becomes how agents obtain credentials, being a native part of it is worth more than any
feature currently on Latch's list — and being *late* to it costs more than being late to most things.
Both of those are reasons to write it down now and decide deliberately, not reasons to start today on a
protocol revision neither repo implements.

## Related

- `test/mcp.mjs` — pins the client-side negotiation, including a control server on a supported revision
- [MCP.md](./MCP.md) — what the host-brokered integration is and how to configure it
- Bureau's `MCP-PROTOCOL-SUPPORT.md` — the same decision on the server side
