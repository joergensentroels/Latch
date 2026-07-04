# Contributing to Compass / Latch

Thanks for taking a look. This is a small community project with a serious
security model at its core, so contributions are very welcome — with a couple of
non-negotiables that keep the trust boundary intact.

## Before you start

- Read [README.md](./README.md) for what Compass/Latch is, and
  [GETTING-STARTED.md](./GETTING-STARTED.md) to get a host + worker running.
- Read [SECURITY.md](./SECURITY.md) and [AGENT-BOUNDARY.md](./AGENT-BOUNDARY.md).
  Most of the design decisions here exist to serve that boundary; a change that
  weakens it will be declined even if it's otherwise nice.
- By contributing you agree your changes are licensed under the project's
  **AGPL-3.0-or-later** (see [LICENSE](./LICENSE)).

## The one architectural rule

Compass runs as two parts: a **trusted host** (`server.js`, holds all secrets in
`data/`) and an **untrusted, disposable worker** (`worker/`, holds only the agent
key). Keep them separate:

- **Secrets live only on the host.** Never make the worker read, receive, or need
  the operator key, provider API keys, GitHub tokens, or mailbox credentials.
- **Risky actions go through approvals.** The worker *requests*; the host *acts*
  after an operator (or an explicit autonomy policy) approves. Don't add a code
  path where the worker performs a credentialed action directly.
- **What the operator approves is exactly what runs.** If you touch approval or
  execution plans, the operator-visible text and the executed plan must come from
  the same source (see the F1 finding in
  [SECURITY-FINDINGS-2026-07.md](./SECURITY-FINDINGS-2026-07.md)).

## Conventions

- **Node built-ins only on the host.** `server.js` and its tests deliberately use
  zero runtime npm dependencies (Node 22+). Please don't add a `node_modules`
  dependency without discussing it first — it's a design property, not an
  oversight.
- **The worker is Python 3.11+**, standard library only (`urllib`, etc.).
- **No secrets in the repo.** `data/`, `.env`, and machine-local config are
  gitignored and must stay that way. The secret scanner (below) runs in CI.
- Match the surrounding style: small, readable functions; comments explain *why*,
  especially for anything security-relevant.

## Running the tests

```bash
npm test
```

That runs, in order: the secret scanner, the Python worker tests, the agent-email
unit tests, and the end-to-end smoke test (which boots a real server against a
mock mail transport). The same suite runs in CI
([.github/workflows/ci.yml](./.github/workflows/ci.yml)).

The Python worker tests need `python3` on your PATH. Individual suites:

```bash
node test/secret-scan.mjs
node test/smoke.mjs
node test/agent-email.mjs
python3 test/worker-ssrf.py
```

**If you change security-relevant behaviour, add or update a test.** The smoke
suite is the right home for host-side approval/auth regressions; the `worker/`
Python tests cover bridge and executor behaviour.

## Submitting a change

1. Keep pull requests focused — one coherent change per PR.
2. Run `npm test` and make sure it's green.
3. In the PR description, say what the change does and — if it touches the host,
   the worker, approvals, or anything under `data/` — how it affects the trust
   boundary.
4. Note whether it needs a deploy step (host restart, worker/bridge redeploy) so
   a self-hoster knows what to do after pulling.

## Reporting security issues

Please **don't** open a public issue for a vulnerability. Use the private path in
[SECURITY.md](./SECURITY.md) (GitHub Security Advisories) so it can be fixed before
it's disclosed.
