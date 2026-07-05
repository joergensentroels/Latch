# Unverified changes (pushed, not yet live-tested)

**As of 2026-07-05.** The commits below are pushed to `main` and pass the full automated suite
(`npm test`: secret-scan, Python worker tests, agent-email, mcp, schedule, smoke), but they have
**not yet been deployed to a real host + worker and exercised end-to-end.** They're shared early so a
reviewer can read them; treat behaviour as provisional until the boxes below are checked. Bugs get
fixed after live testing.

Deploy from the working tree (host restart + `Deploy-Worker-To-VM.ps1`; see [DEPLOY.md](./DEPLOY.md)),
then verify. This file gets deleted once everything below is confirmed.

## Commits in this batch

- Draft-with-Latch: scoped /api/draft endpoint + Outlook add-in (draft in Outlook, you send)
- draft-a-reply: host-brokered personal replies (worker drafts, you approve, host sends from your address)
- boundary sweep: F6 fix — unshared context metadata no longer reaches the worker (host restart)
- hardening #3/#4/#5: untrusted inbound-email replies, web-content not auto-shared, non-root executor
- hardening #1 + #2: CI/hook paths never auto/grant; MCP args validated + constrainable
- `a533a3e` autonomy recut: auto-approve only host-verified typed operations + operator grants
- `0d86d67` structured sub-goals (`{text, depth}`)
- `e4b084e` bridge multi-step loop (slice 2, cut 1)
- `280888d` security(mcp): auto-approval bound to a tool fingerprint (tool-poisoning / rug-pull guard)

(Plus the earlier already-pushed batch — MCP, scheduling, multi-step slice 1, security fixes — which
is *also* not yet live-verified; see [DEPLOY.md](./DEPLOY.md)'s pending-batch section.)

## What is covered by automated tests

- Autonomy: arbitrary shell/browser stay `pending` even under full access; grant flow (approve+grant
  → next auto-approves → revoke → human again); arbitrary ops never grantable; agent-key `403` on
  revoke. (`test/smoke.mjs`)
- Grants + typed-op auto-approval logic, per-tier. (`test/smoke.mjs`)
- Structured sub-goals stored as `{text, depth}` with default fallback + legacy coercion.
- Bridge loop state machine: kickoff → checkpoint → advance → finish, and deny/stop.
  (`test/worker-readonly-templates.py`)
- MCP tool fingerprint: stable across `inputSchema` key-order; changes on name/description/inputSchema
  mutation. (`test/mcp.mjs`)

## Not yet verified live — check these on the real host + worker

- [ ] **Autonomy recut end-to-end**: under full access, an arbitrary shell/browser task still produces
      a human approval (does not auto-run). A read-only diagnostic / bounded research still auto-runs.
- [ ] **Operation grants**: approve a typed op (e.g. an MCP tool or bounded research) with "always" →
      the next identical op auto-approves; revoke it in Settings → Autonomy → Allowed operations →
      back to asking. "Session" grant clears after a host restart.
- [ ] **Grants never leak to the worker** (they're host-only): confirm the worker poll payload has no
      grants field.
- [ ] **Multi-step loop (cut 1)**: queue a task with 2–3 sub-goals → it works sub-goal 1, reports,
      files a `task_continue` card → approve → advances → last one finishes; deny mid-way → task
      pauses cleanly (not failed). Watch the per-sub-goal reports read sensibly.
- [ ] **Sub-goal depth** prefills from the Review-Policy default in the Tasks form and round-trips.
- [ ] **UI on the phone**: the sub-goal add/remove rows, the approval dialog's once/session/always
      selector (only shows for grantable ops), and the Allowed-operations list all render and work.
- [ ] **Hardening #1**: a commit to `.github/workflows/**` in CompassProjects does NOT auto-approve
      even under full access, and isn't offered a grant option; a normal file still does.
- [ ] **Hardening #2**: an MCP tool call with malformed/extra args (or args violating a configured
      `argConstraints` prefix) is rejected host-side before running.
- [ ] **Hardening #3**: inbound auto-reply still works for known contacts and doesn't leak internal
      details / obey instructions embedded in a (test) email.
- [ ] **Hardening #4**: after a `search_web` execution, the "Web findings" note appears in Context
      but is NOT shared with the agent (must be manually shared to become agent memory).
- [ ] **Android "Share -> Compass"**: reinstall/refresh the PWA (share_target needs a manifest
      re-read), then in another app select text -> Share -> Compass -> it opens the "Draft a reply"
      composer prefilled with the shared text.
- [ ] **Android HTTP Shortcuts** (optional, instant path): a POST to /api/draft with the draft key
      returns a draft (see DRAFT-REPLIES.md).
- [ ] **Draft-with-Latch add-in (needs HTTPS + sideload into Outlook)**: edit `outlook-addin/manifest.xml`
      host URLs → sideload → open a message → "Draft with Latch" → paste the `draftToken` in Settings →
      Draft a reply → "Open reply with this draft" → send from Outlook. The `/api/draft` endpoint +
      scoped-token behaviour are covered by smoke; the Office.js taskpane is NOT yet tested in a live
      Outlook client.
- [ ] **Draft-a-reply (needs `data/operator-email.json` + worker redeploy)**: Tasks → "Draft a reply
      to a message" → paste a message + reply-to → a draft appears in Review → edit it → approve →
      it sends from your address (check the recipient's inbox); deny → nothing sends. Confirm it
      never auto-approves even under full access, and the worker never sees the send credential.
- [ ] **Hardening #5 (RISKIEST — worker redeploy + install re-run)**: after re-running
      `install-latch-agent-executor.sh`, the executor starts as `latch-executor` (non-root:
      `systemctl show latch-agent-executor -p User`), a **browser** plan still works (Playwright
      finds Firefox via `PLAYWRIGHT_BROWSERS_PATH`), and a **shell** plan still runs. Watch for
      permission errors in `journalctl -u latch-agent-executor` — the non-root + Playwright-path
      interaction is the most likely thing to need a fix.
- [ ] **MCP tool-poisoning / rug-pull guard (`280888d`)**: with an MCP server (mock or real) exposing
      a tool listed in that server's `autoApprove`, under Full access → the first request auto-approves
      AND records a fingerprint (timeline event `mcp.tool.fingerprint.recorded`). Then change that
      tool's **description** (or `inputSchema`) at the server and request it again → it must **NOT**
      auto-approve; it files a human approval (event `mcp.tool.fingerprint.changed`). Also confirm a
      tool that isn't currently discoverable falls back to a human. Host-side, computed at approval
      creation → **takes effect on host restart** (no worker redeploy needed).
- [ ] **Browser `extract_text` trust (static review says safe — spot-confirm)**: reviewed at
      server.js:3632 (extract_text isn't saved as agent-shared context), bridge:407 (agent-authored
      report messages aren't re-ingested — `operator_to_agent` only), and the sub-goal loop feeds model
      summaries not raw page text. Spot-check: a browse-and-`extract_text` task against a page carrying
      adversarial "instructions" must not trigger any auto-executed follow-on action (all actions stay
      human-gated). No code change was needed here.

## Known scope limits (by design, not bugs)

- **Multi-step cut 1** does *reasoning* per sub-goal — it does not yet dispatch a real gated executor
  action per sub-goal and auto-advance on its result (cut 2). See [MULTI-STEP-TASKS.md](./MULTI-STEP-TASKS.md).
- Session-grant expiry is host-restart + a 12h TTL, not a per-login session.
