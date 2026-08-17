# MCP protocol support

**Latch speaks Model Context Protocol revisions `2025-06-18` and `2026-07-28`, as a client only.**
Which of them is reachable depends on the transport.

Recorded 2026-08-15; revised 2026-08-17 when the HTTP transport landed and the modern era became reachable.
See [MCP.md](./MCP.md) for what the host-brokered MCP integration *is*; this file records which revisions it
speaks and what that deliberately excludes.

It exists because a version constant with nothing written around it is a claim nobody can check. Latch
announced `2025-06-18` in `initialize` and then ignored whatever the server answered — so a server replying
with a revision Latch had never implemented was treated as agreement, and the host went on to broker
credential-bearing tool calls over a wire format it could not actually speak.

If you change `SUPPORTED_PROTOCOL_VERSIONS` or `LEGACY_PROTOCOL_VERSIONS` in `mcp.mjs`, change this file in
the same commit.

## Which role Latch plays

Latch is an MCP **client/host**. It connects *out* to MCP servers, holds their credentials, and runs approved
tool calls on the worker's behalf. There is no MCP server endpoint anywhere in Latch — `/api/mcp/servers` is
Latch's own REST API for listing configured servers, not an MCP surface. Nothing outside Latch can speak MCP
*to* it.

That asymmetry is why this file's scope differs from Bureau's: Bureau's `MCP-PROTOCOL-SUPPORT.md` covers a
server, this one covers a client, and the two halves of version negotiation land differently.

## The transport decides which era is reachable

| Transport | Era | Revisions |
| --- | --- | --- |
| `stdio` | legacy only | `2025-06-18` |
| `http` | dual-era | `2026-07-28` preferred, `2025-06-18` by fallback |
| `mock` | n/a | test seeding, no wire protocol |

`stdio` stays legacy-only on purpose. `initialize` is how a client *selects* legacy semantics, and there is no
modern stdio server to negotiate with. The two version lists are separate in the code for a reason a test now
pins — see "the constant that nearly broke stdio".

| Revision | Era | Latch |
| --- | --- | --- |
| `2025-06-18` | legacy (`initialize` handshake) | **implemented**, both transports |
| `2025-11-25` | legacy | not implemented |
| `2026-07-28` | modern (per-request `_meta`) | **implemented**, http only |

"Legacy" and "modern" are the `2026-07-28` spec's own terms.

## How the era is decided on HTTP

By **probing**, not by configuration. The client POSTs `server/discover` — which the modern spec says a server
MUST implement — wrapped in the modern envelope, and reads the answer:

| Response | Read as | Action |
| --- | --- | --- |
| `200` + a result | modern | proceed with per-request `_meta` |
| `-32022` naming `data.supported` | modern, wrong revision | retry **once** on the best shared revision, in Latch's preference order |
| `-32022` with no shared revision | modern, incompatible | **refuse**, naming both sides |
| `-32020` / `-32021` / a `-32602` about `_meta` | modern, and Latch's request was malformed | **refuse** — see below |
| `401` / `403` | undetermined; this is a credential fault | **refuse**, naming auth explicitly |
| `-32601`, `404`, anything else | no evidence of a modern peer | fall back to `initialize` |

The decision is cached per server for 60s, so a tool call does not re-probe.

### Why a modern error must not trigger the fallback

`-32020`–`-32099` is reserved for the specification, and only a modern server emits a code in that range. So
receiving one is *evidence about the peer* — and when the code says Latch's own request was malformed, falling
back would run the legacy path, succeed, and pass a client defect off as a working connection. The client
refuses instead, and says that is what it is doing.

`test/mcp.mjs` pins it by asserting that **no `initialize` is attempted** after a `-32020`. The absence is the
half that proves it did not fall back; the thrown error alone would be satisfied by any failure.

### Why a 401 is not an era

Because it was read as one, once. Pointing the client at Bureau with a **wrong token** reported *"fell back to
the initialize handshake"*: a 401 carries no modern error code, so the fallback fired and the message named a
protocol difference that did not exist, while the actual cause went unmentioned. An auth failure now refuses
and says so. Found by a negative control on `tools/mcp-interop.mjs`, not by reading the code.

## What the legacy handshake does

Latch announces a legacy revision and **reads the answer**. The spec puts this decision on the client:

> If the client does not support the version in the server's response, it SHOULD disconnect.

— MCP `2025-06-18`, Lifecycle / Version Negotiation. The server is entitled to answer with a revision Latch
did not ask for. Latch refuses: the connection is torn down (on stdio, stdin closed and the child killed — the
shutdown the spec describes) and the operator gets an error naming both the revision the server chose and the
one Latch speaks. A server that announces no version at all is refused too; absent is not compatible.

Refusing matters more here than in a general-purpose client. Every op on that connection is a
credential-bearing tool call a human approved *on the understanding that the host could talk to the server*.
Proceeding on a guessed protocol would turn an approval for one thing into an attempt at another.

### The constant that nearly broke stdio

Adding the modern revision to `SUPPORTED_PROTOCOL_VERSIONS` for the HTTP transport silently widened what the
**stdio** handshake would accept. A stdio server answering `initialize` with `2026-07-28` would have been
accepted, and Latch would have gone on to run credential-bearing ops believing it had agreed a revision whose
handshake and session do not exist — exactly the defect this file was written to close, reintroduced from one
transport away by widening a shared constant.

The existing assertion in `test/mcp.mjs` caught it on the first run. The handshake now checks
`LEGACY_PROTOCOL_VERSIONS`, which is why that list exists separately from the other.

## What the modern era sends

| Rule | Latch |
| --- | --- |
| `_meta` per request | `protocolVersion` and `clientCapabilities` on **every** request, namespaced `io.modelcontextprotocol/`. `clientInfo` too, though it is only SHOULD |
| `clientCapabilities` | Sent as `{}`, truthfully — Latch consumes tools and nothing else. Claiming a capability it lacks would earn a call it cannot complete |
| Mirrored headers | `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` on `tools/call`. Built from the same message object that gets serialised, so the two cannot drift |
| `Mcp-Name` encoding | Plain when the name is printable ASCII; the `=?base64?…?=` sentinel otherwise. Round-tripped against Bureau's own decoder, including a name that contains the sentinel delimiters |
| `resultType` | `"complete"` accepted; **absent** accepted, because earlier revisions require reading absence as complete; anything else **refused** |
| Redirects | `redirect: "manual"` — following one would re-send the credential headers to wherever it points |
| Batching | Never sent. `2026-07-28` requires one request or notification per POST |

### Why a non-complete result is refused

`resultType` can name a Task — "ask again later", not "here is your answer". Latch implements no Tasks
extension, so a task handle reaching the result normaliser would surface as a tool call that ran and returned
very little: an approval for one thing quietly becoming another. Same class of defect as proceeding on a
guessed protocol, and refused for the same reason.

## Sending credentials off the machine

The `http` transport can reach another host; `stdio` cannot, because a subprocess is local by construction.
Credentials for an HTTP server are headers, so:

- **`allowRemote: true` is required** for any non-loopback URL. Default false means a typo in a hostname fails
  closed instead of posting a bearer token somewhere unintended. The refusal happens *before* any request,
  which a test asserts by counting requests rather than by reading the error.
- The check is a **hostname** test, not a DNS resolution. Resolving would add a TOCTOU gap — a name could
  resolve to loopback at check time and elsewhere at request time — and would make an offline check depend on
  a resolver. A literal loopback host cannot be repointed by DNS at all. That is a narrower claim than "this
  address is local", and it is the one that holds without a network.
- `publicMcpConfig` reports **`headerKeys`, never values**, exactly as it already reduced `env` to `envKeys`.
  A test asserts a distinctive token literal appears nowhere in the serialised output, with a control proving
  that search reads real output rather than an empty object.
- The MCP panel marks such a server **`remote credentials`** in red, beside the URL it already showed. An
  operator should not have to infer credential egress by reading a hostname.

## Verifying it against a real server

`test/mcp.mjs` drives the client against an inline HTTP peer that grades every request the way Bureau's server
does — rejecting a missing `_meta` field, a mismatched mirrored header, an unencoded non-ASCII name. That
establishes the client obeys the rules *as this repo understands them*, and nothing about whether that
understanding matches a server someone else wrote from the spec.

`tools/mcp-interop.mjs` is the second claim:

```
node tools/mcp-interop.mjs http://127.0.0.1:<port>/mcp --token-env BUREAU_TOKEN
```

A tool rather than a suite entry, deliberately: a test would have to skip when no server is reachable, and a
check that silently skips is the shape a check makes when it never looked.

Verified 2026-08-17 against Bureau's real dual-era `POST /mcp` — era negotiated **`modern @ 2026-07-28`**,
`tools/list` returned its seven tools, `tools/call list_agents` completed. The tool's exit status is its whole
contract, so both failure paths were confirmed to exit non-zero (wrong token, nothing listening) — and its
first version exited **127 on success**, crashing libuv by calling `process.exit()` while a keep-alive socket
was closing. It sets `process.exitCode` now.

## What is still not implemented

`2025-11-25` — the legacy revision between the two. Nothing has been verified against it.

Within `2026-07-28`: no resources, prompts, completions, logging, sampling or elicitation; no
`subscriptions/listen` stream; no Tasks extension (a task result is refused rather than mishandled — see
above); no `ttlMs`/`cacheScope` handling on results; no Multi Round-Trip Requests, which Latch's own tools
never need because nothing asks the host for input mid-call.

Server-Sent Events are not implemented either. The `http` transport is request/response only: one POST per op,
matching the ephemeral shape the stdio transport already had.

## Known gaps

- **stdio stays legacy-only.** No modern stdio server exists to negotiate against, and `initialize` is how a
  client selects legacy semantics. If one appears, `negotiateHttpEra`'s probe logic is the part to
  generalise — not the constants.
- **`2025-11-25` is unclaimed.** Older revisions may well be wire-compatible with the tools-only subset Latch
  uses, but nobody has verified it, so nothing claims it. Widening a list is a deliberate act with a check
  attached.

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

- **~~It requires the modern era.~~ That blocker is gone, and the remaining ones are not.** This item read
  "the `2026-07-28` machinery this document just declined — the opportunity and the rewrite are the same piece
  of work". Half of it is now built: as of 2026-08-17 Latch speaks the modern era as a **client** over HTTP.
  What URL-mode elicitation needs is the modern era on a **server** surface plus Multi Round-Trip Requests,
  and Latch has neither. So the work did not shrink by as much as the tick mark suggests — the envelope,
  version negotiation and header mirroring are done and reusable; the role reversal is untouched.
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
Both of those are reasons to write it down now and decide deliberately.

## Related

- `test/mcp.mjs` — pins the client-side negotiation for both eras, each assertion with a control
- `tools/mcp-interop.mjs` — the same client against a real server, run by hand
- [MCP.md](./MCP.md) — what the host-brokered integration is and how to configure it
