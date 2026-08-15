# Testing status

**Host behaviour as of 2026-08-15; live-hardware section as of 2026-07-05.** What has been verified
for this release, and what has not.

## Verified

**Automated suite (`npm test`) — green.** Runs against the real `server.js`:

- secret scan (no secrets/PII in the tree)
- worker templates + executor + SSRF hardening (Python)
- agent-email, MCP (including the real stdio transport), scheduling, and the full smoke suite
- MCP tool-poisoning / rug-pull guard, end-to-end (`test/mcp-fingerprint.mjs`)
- the GitHub connector's write path, end-to-end (`test/github-write-path.mjs`)

The smoke suite exercises the security-critical host behaviour directly: arbitrary shell/browser
plans stay `pending` (human-required) even under Full access; operation grants (grant → auto-approve
→ revoke → human again); arbitrary operations are never grantable; the agent key is rejected on
revoke; CI/workflow-path commits never auto-approve; MCP tool arguments are validated against the
tool's declared schema; and web-search findings are not auto-shared with the agent.

**The GitHub connector's write path** (`test/github-write-path.mjs`). This is the subsystem that holds
the GitHub token and creates branches, commits and pull requests on the operator's approval. It is
driven against a mock GitHub API — the connector's base URL is an env var — which records every
request, so the assertions are about the bytes that reached the API rather than about what the host
says it sends. Covered: `github_issue`, `github_issue_comment` and `github_pull_request` stay
`pending` under Full access and are never grantable; filing an approval touches the API zero times;
a **denied** approval reaches the API zero times; an approved one sends exactly the typed fields the
operator saw (each fixture's free-text `title` differs from its typed field on purpose, so a test can
only pass by reading the typed one); a pull request branches from the approved base, commits the
approved bytes onto the new branch, and opens with the approved title/head/base; and a **failed**
write returns the approval to `pending` with the reason rather than recording it as done.

The "stays pending" assertions carry a positive control — an own-repo `github_file` commit that
auto-approves in the same run under the same policy — because on their own they would also pass with
the hard boundary deleted, since no Full-access rule matches these types either.

**The connector panel's read routes** (same file). `/api/github/doctor`, `branches` and
`delete-branch` now have a UI (Settings → GitHub connector), so they are checked the way that catches
what actually breaks a panel: `renderGithubDoctor` and `renderGithubBranches` are pulled out of
`public/app.js` and RUN on the real endpoint responses, and the assertions are on the HTML they
produce. A field renamed on either side drops those values out of the output and the check goes red —
which a name-by-name comparison of the JSON would not catch, since the panel can read a field the
endpoint never had and simply render nothing. Also covered: the doctor never echoes the token and
still reports what no read can verify; delete-branch refuses the default branch and any branch with an
open pull request, and neither refusal reaches the DELETE.

Verified in a browser (Playwright, desktop 1280px and phone 375px) against the same mock: the panel
renders, the delete runs end to end through its confirm, and there are no console errors. Three
defects no assertion caught were fixed there — the button stretched into a full-width bar, a run-on
sentence in the failed-capability note, and a 21px horizontal overflow at phone width.

Not covered by the suite: `/api/github/repo-settings`, `close` and `issues`, which still have no UI
and no test.

**Live host + worker — verified on real hardware (2026-07-05):**

- The deployed worker (`latch-agent-bridge.py`, `latch-agent-executor.py`) matches the repo byte-for-byte.
- The executor runs as a dedicated **non-root** user (`latch-executor`), confirmed on the live VM.
- A real **shell** plan runs under it (`whoami` → `latch-executor`, exit 0).
- A real **browser** plan runs under it (Playwright/Firefox `search_web`, exit 0) — the non-root +
  `PLAYWRIGHT_BROWSERS_PATH` interaction works.
- Browser execution correctly required human approval before running.

## Not yet tested on a device (optional client integrations)

These are convenience entry points. The underlying `/api/draft` endpoint and its scoped-token
behaviour are covered by the automated smoke suite, but the client/device pieces have not been
exercised on real hardware yet:

- **Android "Share → Compass"** (Web Share Target) — reinstall/refresh the PWA, then share text from
  another app into Compass.
- **Android HTTP Shortcuts** — POST to `/api/draft` with the draft key.
- **Outlook add-in ("Draft with Latch")** — the Office.js taskpane has not been sideloaded into a
  live Outlook client (needs HTTPS via Tailscale Serve + a manifest sideload).
- **Phone UI** — the newer controls (autonomy selector, allowed-operations list, sub-goal rows) have
  been exercised in a desktop browser but not verified on a phone.

None of these affect the security model or the worker trust boundary; they are UI/client
conveniences that will be verified as they are used.
