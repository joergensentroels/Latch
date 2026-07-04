# Multi-step tasks (bounded autonomy)

Some work needs several actions in a row — "research three competitors, draft a comparison, email me
the draft." Compass handles this as a **bounded, checkpointed loop** so the agent can make progress
across steps without ever running away from you.

The safety comes from the design, not from trust:

## Only through the Tasks pane

Autonomous multi-step work can only be queued as a **task**. Inbox/chat stays single-shot — one
message produces at most one gated action. Handing the agent a long leash is therefore always a
deliberate act on a surface built for review; a casual chat message can never start a loop.

## Two checkpoints, one approval

A running task pauses, summarizes its state, and files an **always-human** `task_continue` approval at
either boundary:

- **Depth (the number)** — the **per-sub-goal step budget**: the most actions that stage may take
  before it must check in. Each sub-goal has its own, prefilled from the operator's global "default
  steps" (Settings → Review Policy) and editable per stage. This is the blunt safety backstop.
- **Sub-goals (the meaning)** — an **explicit, operator-defined** ordered list of milestones, each an
  object `{text, depth}`. The count and boundaries are your data, never inferred by the model — it
  only does the work *inside* a stage and **stops and reports** at each boundary, so every check-in is
  meaningful ("finished stage 1: scraped 3 sites — go to stage 2?"). Each sub-goal carries its **own
  depth** (the step cap for that stage), prefilled from the global default and editable per stage.

`task_continue` is never auto-approvable — even under Full access, the decision to keep going is
always yours. That's what makes the budget mean something. This stacks on top of the existing
autonomy tiers: every individual risky step is *still* approval-gated by your review policy; the loop
budget is a second, independent bound.

So autonomy is really two dials: **breadth** (which action types auto-approve — the four tiers) ×
**depth** (how many steps before a check-in — the step budget).

## Status

**Slice 1 — shipped (host + UI):** the data model (per-task `stepBudget`, `subGoals`, `subGoalIndex`,
`stepCount`, `loopStatus`), the operator default budget (`autonomyPolicy.defaultStepBudget` + slider),
the `task_continue` approval type (always-human), and the Tasks-form UI: an explicit add-a-sub-goal
list where each row is `{text, depth}` and the depth prefills from the global default.

**Slice 2 (cut 1) — built, pending live test (worker):** a queued task with sub-goals now runs the
loop. The bridge works the current sub-goal (LLM, in the companion voice, using progress-so-far),
reports the result, mirrors progress onto the task, and files a `task_continue` checkpoint. Approving
it advances to the next sub-goal; the last sub-goal finishes the task; denying stops it cleanly
(`paused`, not failed). Covered by `test/worker-readonly-templates.py` (kickoff → checkpoint →
advance → finish, plus the deny/stop path) and `test/smoke.mjs` (host side). Deploys on host restart +
bridge redeploy.

**Cut 2 — not yet built:** each sub-goal currently produces a *reasoning/plan* result and checkpoints;
it does not yet dispatch a real gated executor action (browse/shell) *per sub-goal* and auto-advance
when that action's result returns. That async "dispatch → await result → re-plan" step — and using
each sub-goal's **depth** to bound multiple actions *within* that stage before an early check-in — is
the next cut. Until then each sub-goal's depth is stored and enforced-ready, and the natural bound is
one report per sub-goal.
