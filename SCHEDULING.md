# Scheduled (recurring) tasks

Compass can run instructions on a schedule. A **schedule** is a stored recurring instruction; on a
timer the host turns it into a normal **task**, which then flows through the exact same
detect → approve → execute pipeline as any other task. There's no new execution surface and no change
to the trust model — a scheduled task is just an ordinary task that the host queues for you.

Use it for the proactive things: a morning digest, a weekly repo-health check, "watch this page and
email me if it changes".

## Cadence

Three kinds:

- **Daily** at a time of day (`atTime`, e.g. `07:30`).
- **Weekly** on a weekday (`dayOfWeek`, 0=Sunday … 6=Saturday) at a time of day.
- **Every N minutes** (`interval`, 5 minutes … 14 days).

Times are the **host's local time**. The next run is always computed forward from *now*, so if the
host was off it resumes at the next slot rather than firing a burst of catch-up runs.

## How a run works

1. The host's timer (same loop as the simple planner) checks for due, enabled schedules.
2. Each due schedule materializes a queued task (linked back via `scheduleId`) on the schedule's
   channel (default `operations`), and its next run is advanced.
3. The bridge picks the task up and it goes through the normal pipeline — including approvals. A
   scheduled task that needs a real action still produces an approval card; scheduling does **not**
   bypass your review policy.

## Manage

**Settings → Automation → Scheduled tasks**: add a schedule (title, instructions, cadence), and per
schedule **Run now**, **Pause/Resume**, or **Delete**. All schedule management is operator-only.

API (operator): `POST /api/schedules`, `PATCH /api/schedules/:id`, `DELETE /api/schedules/:id`, and
`POST /api/schedules/:id/run` (run once immediately — also handy for testing a schedule).

## Notes

- Pausing a schedule clears its next run; resuming recomputes it.
- Pairs naturally with [MCP](./MCP.md): a schedule whose instruction resolves to an MCP tool call
  gives you recurring, approval-gated tool runs.

## Status

Implemented host-side (cadence logic in `schedule.mjs`, timer + CRUD + run-now in `server.js`) with
a Settings UI. Covered by `test/schedule.mjs` (cadence math) and the end-to-end path in
`test/smoke.mjs` (create → run-now → task, pause/resume, operator-only, delete). Takes effect on host
restart; the UI is static (PWA reload).
