# Autonomy: typed operations, not arbitrary trust

How much Compass does without asking is controlled by two independent dials. The design rule behind
both — sharpened by external review — is: **auto-approval rests only on operations the trusted host
can verify by construction. Arbitrary operations are never auto-run, and worker-asserted risk is
never a gate.**

## Why it works this way

The credential-isolation promise ("the worker never holds your secrets") leaks if the *gate* on
auto-execution is something the worker itself supplies. A prompt-injected worker that can label a
malicious action "not sensitive" — and have the host then run it — is one injection away from making
the host use credentials the worker never held. And an *arbitrary* operation (a free-form shell
command) can't be reliably validated host-side anyway; the only real gate is a human reading it.

So auto-approval is based on **operation type**, host-classified, with per-type host validation
(allowlists, schemas, scope) — never on the worker's own `sensitive`/`riskLevel` flags, and never for
free-form execution.

## Dial 1 — tiers (breadth over typed operations)

- **Approve everything** (default): nothing auto-runs.
- **Auto read-only**: read-only diagnostics (fixed host templates) + bounded exact-URL research.
- **Auto typed tools**: the above + operator-listed MCP tools.
- **Auto all typed ops**: the above + `CompassProjects` file commits + low-risk typed requests.

**Arbitrary shell and browser plans are never auto-approved in any tier** — a human always reads the
exact plan. The hard human boundaries (credentials, purchases, email/external contact, account and
repo creation, verification, continue-checkpoints) are also always human, enforced host-side by type.

## Dial 2 — operation grants (an allowlist you build up)

When you approve a *typed* operation you can also grant it — "allow for this session" or "always
allow" — so the same operation auto-runs next time without asking, in any tier (like Claude Code's
session allowlist). Grants:

- only ever match **host-verifiable typed operations** (an MCP tool, a diagnostic template, bounded
  research, `CompassProjects` commits). **Arbitrary shell/browser can never be granted.**
- live **only on the trusted host** and are treated as sensitive — they are never sent to the worker.
- **session** grants clear when the host restarts (and after a TTL, default 12h); **always** grants
  persist until you revoke them. Manage them in **Settings → Autonomy → Allowed operations**.

## The net effect

The agent can only ever get auto-execution for a *fixed vocabulary of operations the host can reason
about* — plus whatever specific typed operations you've explicitly allowed. Everything outside that
vocabulary, and everything arbitrary, needs you. That's a deliberately smaller surface than "let the
agent do anything and classify the risk," and it's the point: bounded, typed operations are the only
ones that can be made safe.
