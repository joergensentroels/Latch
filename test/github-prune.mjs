// Unit tests for the branch-pruning decision (github.mjs).
//
// This exists because the interesting answer — `prunable: true` — is unobservable from outside without
// creating and then closing a real pull request. The endpoint was verified to return 200 with the right
// shape against the live sandbox, but every branch there was the default one, so the boolean that decides
// whether an operator is told "you may delete this ref" had never once been seen to be true.

import assert from "node:assert/strict";
import { newestClosedByRef, classifyBranch } from "../github.mjs";

// ---- newestClosedByRef -------------------------------------------------------
{
  // GitHub lists newest-first. A branch reused by several PRs must be judged on the latest.
  const prs = [
    { number: 9, head: { ref: "feature" }, merged_at: null },
    { number: 4, head: { ref: "feature" }, merged_at: "2026-07-01T00:00:00Z" },
    { number: 7, head: { ref: "other" }, merged_at: "2026-07-02T00:00:00Z" },
  ];
  const m = newestClosedByRef(prs);
  assert.equal(m.get("feature").number, 9, "the newest PR for a ref wins");
  assert.equal(m.get("feature").merged, false, "and its merged state is the one that counts");
  assert.equal(m.get("other").merged, true);
  assert.equal(m.size, 2);
}
{
  // merged_at is the only trustworthy signal. `state` is "closed" for merged and unmerged alike, and the
  // LIST representation omits `merged` entirely — trusting it would label every merged PR abandoned.
  const m = newestClosedByRef([{ number: 3, head: { ref: "x" }, state: "closed", merged_at: "2026-07-01T00:00:00Z" }]);
  assert.equal(m.get("x").merged, true, "merged_at present => merged");
  const m2 = newestClosedByRef([{ number: 3, head: { ref: "x" }, state: "closed" }]);
  assert.equal(m2.get("x").merged, false, "no merged_at => closed without merging");
}
{
  assert.equal(newestClosedByRef(null).size, 0, "tolerates null");
  assert.equal(newestClosedByRef([{ number: 1 }]).size, 0, "a PR with no head ref is skipped, not stored under ''");
  assert.equal(newestClosedByRef([{ number: "nope", head: { ref: "a" } }]).get("a").number, 0, "a non-integer number degrades to 0");
}

// ---- classifyBranch: the refusals ------------------------------------------
const CLOSED_UNMERGED = { number: 12, merged: false };
const CLOSED_MERGED = { number: 12, merged: true };

for (const [label, input] of [
  ["the default branch is never prunable", { name: "main", isDefault: true, closedPr: CLOSED_UNMERGED }],
  ["a protected branch is never prunable", { name: "release", protectedBranch: true, closedPr: CLOSED_UNMERGED }],
  ["a branch with an OPEN pr is never prunable", { name: "wip", openPr: 5, closedPr: CLOSED_MERGED }],
  ["a branch with no finished pr is never prunable", { name: "scratch", closedPr: null }],
  ["an unnamed branch is never prunable", { name: "" }],
]) {
  const v = classifyBranch(input);
  assert.equal(v.prunable, false, label);
  assert.ok(v.reason.length > 0, `${label} — and it says why`);
}

// The one that matters most: an open PR must win even when an older PR merged on the same ref. Getting this
// backwards deletes a branch out from under a review in progress, which closes the PR and discards it.
assert.equal(classifyBranch({ name: "wip", openPr: 5, closedPr: CLOSED_MERGED }).reason,
  "pull request #5 is still open against it");

// Work in progress with no PR yet is the case a naive "no open PR" rule would destroy.
assert.match(classifyBranch({ name: "scratch" }).reason, /work in progress/);

// ---- classifyBranch: the two prunable cases -------------------------------
{
  const v = classifyBranch({ name: "bureau/abandoned", closedPr: CLOSED_UNMERGED });
  assert.equal(v.prunable, true, "closed without merging => prunable");
  assert.match(v.reason, /closed unmerged in #12/);
  assert.match(v.reason, /delete_branch_on_merge never fires/, "names the gap it is covering");
}
{
  const v = classifyBranch({ name: "bureau/done", closedPr: CLOSED_MERGED, defaultBranch: "main" });
  assert.equal(v.prunable, true, "merged, branch left behind => prunable");
  assert.match(v.reason, /merged in #12/);
  assert.match(v.reason, /commits are on main/, "reassures that nothing is lost");
}
{
  // Distinct wording per case, because the two call for different amounts of hesitation.
  const a = classifyBranch({ name: "a", closedPr: CLOSED_UNMERGED }).reason;
  const b = classifyBranch({ name: "b", closedPr: CLOSED_MERGED }).reason;
  assert.notEqual(a, b, "merged and abandoned must not read the same");
}

// ---- defaults ---------------------------------------------------------------
assert.equal(classifyBranch().prunable, false, "no argument at all is a refusal, not a crash");
assert.equal(classifyBranch({ name: "x", closedPr: CLOSED_MERGED }).reason,
  "merged in #12 — commits are on the default branch", "falls back to a readable default branch name");

console.log("github-prune: all assertions passed");
