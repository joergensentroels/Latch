import { readdir, readFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { gitSafeEnv } from "../tools/git-env.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirs = new Set([".git", "data", "node_modules", "__pycache__"]);
const binaryExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".ico"]);

// WHAT GIT WOULD PUBLISH, asked of git rather than kept in a list here.
//
// This scan used to fail on any hit anywhere in the working tree. That blocked a push on `latch.log`,
// which is matched by `*.log` in .gitignore and therefore cannot reach a remote by any path — the server
// had simply logged its own tailnet bind address after a restart. The finding was real and the file was
// unpublishable, and the two are different things.
//
// It matters more than a tidiness complaint. A gate that blocks a push over something git will never
// publish, on a file the running server rewrites continuously, fails on every push until somebody
// deletes the log. That is how `--no-verify` becomes routine, and a gate people routinely bypass will
// not stop the real finding either. Crying wolf is a security defect in a security check.
//
// So the distinction is drawn where it actually lies — publishable or not — and it is drawn by GIT,
// not by the `ignoredDirs` set above. That set is a hand-kept list of what to skip, which is the shape
// that cannot notice something absent from itself; it stays only as a cheap walk-pruner for large
// directories. `data/` being on it is now belt-and-braces rather than the mechanism.
//
// Fails CLOSED: if git cannot answer, nothing is treated as ignored and every hit fails the run, which
// is the old behaviour. A scan that quietly stops failing because a subprocess broke is the worst of
// the available outcomes.
const ignoredPaths = (() => {
  try {
    // gitSafeEnv: an inherited GIT_DIR would point this at a DIFFERENT repository, and the answer would
    // look perfectly plausible — a list of ignored files belonging to some other tree, used to decide which
    // matches in THIS tree are publishable. The pre-push hook runs npm test, so that path is live.
    const out = execFileSync("git", ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"],
                             { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
                               env: gitSafeEnv(process.env) });
    return new Set(out.split("\0").filter(Boolean));
  } catch {
    return null;   // null, not empty — "unknown", and the caller treats unknown as publishable
  }
})();
const isPublishable = (relative) => ignoredPaths === null || !ignoredPaths.has(relative);

const patterns = [
  {
    // Tailscale's whole CGNAT allocation (RFC 6598, /10 block), not one operator's specific address.
    name: "Tailscale IP",
    regex: /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g
  },
  {
    name: "operator token",
    regex: /\bop_[A-Za-z0-9_-]{12,}\b/g,
    allow: (match) => match === "op_replace_me" || match === "op_test_operator"
  },
  {
    name: "agent token",
    regex: /\bagent_[A-Za-z0-9_-]{12,}\b/g,
    allow: (match) => match === "agent_replace_me" || match === "agent_test_agent"
  },
  {
    name: "common API key",
    regex: /\b(sk-[A-Za-z0-9_-]{16,}|mistral_[A-Za-z0-9_-]{16,})\b/g
  },
  // Local, machine-specific secrets that must never be baked into a tracked pattern go in
  // data/secret-scan-denylist.txt (one literal string per line). That file lives under the
  // gitignored data/ dir, so it never ships with the repo.
  ...(await loadLocalDenylist()).map((secret) => ({
    name: "locally denylisted secret",
    regex: new RegExp(escapeRegExp(secret), "g")
  }))
];

const findings = [];        // in files git would publish — these fail the run
const unpublishable = [];   // in files git ignores — reported, but they cannot reach a remote
for await (const file of walk(root)) {
  const relative = path.relative(root, file).replaceAll("\\", "/");
  const text = await readFile(file, "utf8");
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.regex)) {
      const value = match[0];
      if (pattern.allow?.(value, relative)) continue;
      const line = lineNumber(text, match.index || 0);
      // Never the matched VALUE — this output goes to terminals, CI logs and pasted bug reports, and
      // printing the secret to report the secret has been its own incident in other projects.
      (isPublishable(relative) ? findings : unpublishable).push(`${relative}:${line} ${pattern.name}`);
    }
  }
}

// Said before the verdict, so it is read either way. Silence here would be the wrong trade: the file is
// unpublishable today and one `git add -f` away from not being.
if (unpublishable.length) {
  console.warn(`Secret scan: ${unpublishable.length} match(es) in files git IGNORES — not published, not failing:`);
  for (const finding of unpublishable) console.warn(`- ${finding}`);
  console.warn("  (a runtime log or local file. Harmless where it is; do not commit it with -f.)");
}

if (findings.length) {
  console.error("Secret scan failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Secret scan passed.${ignoredPaths === null ? " (git could not list ignored files; every match was treated as publishable)" : ""}`);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
      continue;
    }
    if (!entry.isFile()) continue;
    if (binaryExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    const info = await stat(fullPath);
    if (info.size > 1_000_000) continue;
    yield fullPath;
  }
}

function lineNumber(text, index) {
  return text.slice(0, index).split("\n").length;
}

async function loadLocalDenylist() {
  try {
    const text = await readFile(path.join(root, "data", "secret-scan-denylist.txt"), "utf8");
    return text.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
