// Pure GitHub helpers, extracted so the decisions can be tested without a network call or a live server.
//
// Only the branch-pruning logic lives here so far. It was written inline in the /api/github/branches route,
// where the one thing that matters about it — WHEN it is safe to say "you may delete this ref" — could not
// be exercised: proving `prunable: true` from outside would have meant creating and closing a real pull
// request just to observe a boolean.

// GitHub returns pull requests newest-first. A branch can be reused by several PRs, and only the LATEST one
// describes its current state: an old merged PR must not make a branch whose newest PR is still open look
// finished. So the first entry seen for a ref wins, and later (older) ones are ignored.
export function newestClosedByRef(closedPrs) {
  const out = new Map();
  for (const p of Array.isArray(closedPrs) ? closedPrs : []) {
    const ref = String(p?.head?.ref || "");
    if (!ref || out.has(ref)) continue;
    const n = Number(p?.number);
    out.set(ref, {
      number: Number.isInteger(n) && n > 0 ? n : 0,
      // merged_at is the only trustworthy signal. `state` is "closed" for merged and unmerged alike, and
      // `merged` is absent from the LIST representation — reading it there would call every merged PR
      // abandoned, which inverts the message shown to the operator before a delete.
      merged: Boolean(p?.merged_at),
    });
  }
  return out;
}

// Decide whether a branch may be deleted, and say why either way.
//
// Deliberately NARROW: a branch qualifies only if a pull request actually finished on it. The tempting rule
// — "no open PR" — would sweep away work in progress that simply has no PR yet, which is destructive and
// not recoverable by re-running. The gap being closed is specifically the one delete_branch_on_merge leaves:
// it fires on a MERGE, so a PR closed WITHOUT merging leaves its head branch behind forever.
export function classifyBranch({
  name = "",
  isDefault = false,
  protectedBranch = false,
  openPr = 0,
  closedPr = null,
  defaultBranch = "the default branch",
} = {}) {
  if (!name) return { prunable: false, reason: "unnamed branch" };
  if (isDefault) return { prunable: false, reason: "default branch" };
  if (protectedBranch) return { prunable: false, reason: "protected branch" };
  if (openPr) return { prunable: false, reason: `pull request #${openPr} is still open against it` };
  if (!closedPr) return { prunable: false, reason: "no pull request has finished on it — may be work in progress" };
  return {
    prunable: true,
    // Which case it is matters to whoever reads it before deleting: "the commits are already on main" and
    // "this work was abandoned" call for different amounts of hesitation.
    reason: closedPr.merged
      ? `merged in #${closedPr.number} — commits are on ${defaultBranch}`
      : `closed unmerged in #${closedPr.number} — abandoned, and delete_branch_on_merge never fires for this case`,
  };
}
