// git-env — a spawned process must never inherit the caller's idea of which repository it is in.
//
// Git exports GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and friends into every hook it runs, and every process
// spawned from there inherits them. Nothing here ever wants that: each place that shells out to git names
// its repository with a cwd, and an inherited GIT_DIR silently retargets all of it at whatever repository
// happened to invoke the hook. The pre-push hook runs `npm test`, so that is not a hypothetical path.
//
// PORTED FROM THE SIBLING BUREAU REPO (tools/git-env.mjs), where it exists because of real damage rather
// than caution: `git init -q` with GIT_DIR set does not initialise the directory it runs in, it
// re-initialises GIT_DIR — and with no work tree named, as BARE. That is how `core.bare = true` reached
// that repository's own .git/config, which made every work-tree operation refuse in the main checkout and
// in every linked worktree, so the gate could no longer run and nothing reported it.
//
// Latch's own exposure is narrower and real: test/secret-scan.mjs and test/ps1-encoding.mjs both ask git
// what belongs to the project. Pointed at the wrong repository they do not fail — they answer confidently
// about a different tree, which for a secret scan is the worst available outcome.
export const GIT_ENV_VARS = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES",
  "GIT_QUARANTINE_PATH",
];

// A COPY with those removed, shaped for execFile/spawn's `env` option. A copy rather than a mutation,
// because the argument is almost always process.env and a long-running process must not permanently lose
// variables because it once shelled out to git.
export function gitSafeEnv(env = process.env) {
  const out = { ...env };
  for (const k of GIT_ENV_VARS) delete out[k];
  return out;
}
