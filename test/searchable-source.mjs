// Every source file must be searchable to the end.
//
// WHY THIS EXISTS. server.js built a composite key as `${server.name}<NUL>${name}` — a correct choice,
// because NUL is the one character that cannot occur in either half, so the two halves cannot be made to
// collide. The mistake was writing it as a RAW BYTE rather than as an escape. Ripgrep treats any file
// containing a NUL as binary and stops searching there, so for as long as that byte sat in the source:
//
//   - a recursive search over this repo read server.js up to line 6883 and no further,
//   - the last 238 lines — cleanSubGoals, cleanJsonObject, orderedUnique, cleanResearchSources and the
//     rest — could not be found by any grep,
//   - and the failure was a WARNING on stderr, not an error. The result came back looking complete.
//
// That last point is why this is a gate and not a note. A search that finds nothing and a search that was
// never allowed to look return the same thing. The dead-code audit that produced this repo's roadmap ran
// greps over this file; it happened to be right, but it could not have seen a caller in the hidden tail,
// so "zero callers" was luck rather than evidence.
//
// The check reads raw bytes rather than asking ripgrep, so it holds wherever the suite runs. When rg IS
// available the self-test below demonstrates the truncation on a fixture, which keeps the reasoning above
// honest rather than merely asserted.
import { readFile, writeFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("✓ " + name + (extra ? "   " + extra : "")); }
  else { fail++; console.log("✗ " + name + (extra ? "   " + extra : "")); }
  return cond;
};

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NUL = 0x00;

// Text formats only. A PNG may legitimately contain NULs and nobody greps it for a function definition.
// Matched on extension rather than by sniffing content, because "does this look binary" is precisely the
// judgement that goes wrong here.
const TEXT = new Set([".js", ".mjs", ".cjs", ".json", ".md", ".py", ".html", ".css", ".txt",
                      ".yml", ".yaml", ".ps1", ".sh", ".sql", ".toml", ".ini", ".xml", ".svg"]);

// data/ and data-dev/ hold the credential store and live state. They are deliberately NOT walked: this
// file opens and reads every byte of what it enumerates, that directory is gitignored, and nothing in it
// is source anyone searches. Skipping it is a rule about what this instrument may open, not an oversight.
// .claude added 2026-08-21: it holds another agent session's git worktree — a full checkout of this
// same repository, gitignored and machine-specific. Scanning it means asserting properties about
// files this commit does not control, and for the git-spawn check below it meant reading a STALE
// copy of the very file being checked and reporting it as unscrubbed.
const SKIP = new Set(["node_modules", ".git", ".claude", "data", "data-dev", "backups", "logs", "dist", "coverage"]);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith(".") && entry.isDirectory()) continue;
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (TEXT.has(path.extname(entry.name).toLowerCase())) yield full;
  }
}

const files = [];
for await (const f of walk(REPO)) files.push(f);
ok("the file list is non-empty", files.length > 0, `${files.length} text files scanned`);
ok("and it reached the main source file", files.some((f) => path.basename(f) === "server.js"));

const offenders = [];
for (const full of files) {
  const buf = await readFile(full).catch(() => null);
  if (!buf) continue;
  const at = buf.indexOf(NUL);
  if (at === -1) continue;
  const line = buf.subarray(0, at).toString("utf8").split("\n").length;
  const total = buf.toString("utf8").split("\n").length;
  offenders.push({ rel: path.relative(REPO, full), line, hidden: total - line });
}

ok("no source file contains a raw NUL byte", offenders.length === 0);
for (const o of offenders) {
  console.log(`    ${o.rel}: raw NUL at line ${o.line} — hides the ${o.hidden} lines after it from every search`);
  console.log(`    Write it as the six-character escape instead. The runtime value is identical, so`);
  console.log(`    anything already stored under a key built the old way still matches.`);
}

// ── The instrument's own controls ────────────────────────────────────────────────────────────────────
// A detector reporting "all clear" is indistinguishable from one that never ran. These build files that
// ARE bad and require the detector to say so.
const tmp = await mkdtemp(path.join(tmpdir(), "searchable-"));
try {
  const fixture = path.join(tmp, "fixture.mjs");
  const head = "export function visibleBefore() { return 1; }\n";
  const tail = "export function hiddenAfterTheNul() { return 2; }\n";
  await writeFile(fixture, Buffer.concat([
    Buffer.from(head, "utf8"), Buffer.from([NUL]), Buffer.from("\n" + tail, "utf8"),
  ]));

  const buf = await readFile(fixture);
  const at = buf.indexOf(NUL);
  ok("CONTROL: the detector finds a NUL in a file that has one", at !== -1);
  ok("CONTROL: and reports the line it is on",
     buf.subarray(0, at).toString("utf8").split("\n").length === 2);

  const clean = path.join(tmp, "clean.mjs");
  await writeFile(clean, head + tail, "utf8");
  ok("CONTROL: and finds none in a file that has none", (await readFile(clean)).indexOf(NUL) === -1);

  // A DEMONSTRATION, not a control — deliberately not counted among the checks above. It shows the
  // asymmetry this gate exists for: a RECURSIVE ripgrep over a directory containing that fixture cannot
  // see past the byte, while naming the file directly can. That asymmetry is what makes the bug so quiet,
  // and it briefly "disproved" the whole problem during the original investigation, when searching the
  // file by name turned up the supposedly-hidden function.
  //
  // It usually will not run. On this machine `rg` is a shell function provided by the tooling rather than
  // a binary on PATH, so no spawned process can reach it, and the same is true of most CI images. The
  // three byte-level controls above are what actually hold this gate up; if this block ever silently
  // became the only evidence, the gate would be resting on a check that never executes.
  let missing = false, recursive = "";
  try { recursive = (await run("rg", ["-n", "hiddenAfterTheNul", "."], { cwd: tmp })).stdout; }
  catch (e) { if (e.code === "ENOENT") missing = true; else recursive = String(e.stdout || ""); }

  if (missing) {
    console.log("• ripgrep is not reachable as a binary — the demonstration below did not run. Said out");
    console.log("  loud because a demonstration that quietly no-ops reads exactly like one that passed.");
  } else {
    ok("DEMONSTRATION: a recursive ripgrep genuinely cannot see past a raw NUL",
       !recursive.includes("hiddenAfterTheNul"));
    const byName = await run("rg", ["-n", "hiddenAfterTheNul", "fixture.mjs"], { cwd: tmp })
      .catch((e) => ({ stdout: String(e.stdout || "") }));
    ok("DEMONSTRATION: while naming the file directly finds it, which is how this hides",
       byName.stdout.includes("hiddenAfterTheNul"));
  }
} finally {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
}


// ---- every git spawn must scrub the caller's repository out of its environment --------------------------
//
// WHY HERE. This suite already asserts a structural property over the whole source tree, which is the same
// shape as the question "does every place that shells out to git do it safely". Latch has two such places
// as of 2026-08-21 -- test/secret-scan.mjs and test/ps1-encoding.mjs -- and both ask git what belongs to
// the project. Pointed at the wrong repository they do not fail: they answer confidently about a different
// tree, and for a secret scan that is the worst available outcome.
//
// The hazard is live rather than theoretical. .githooks/pre-push runs `npm test`, and git exports GIT_DIR
// and friends into every hook it runs. The sibling Bureau repo carries the incident: `git init -q` with
// GIT_DIR set re-initialises GIT_DIR as BARE rather than the directory it runs in, which is how
// `core.bare = true` reached that repository's own config and stopped every work-tree operation.
//
// A DERIVED CHECK rather than a note in tools/git-env.mjs saying "remember to use this". Both spawns are
// scrubbed today; this is what makes a third one a test failure instead of a silent hole. The evidence from
// this repository's own history is that prose does not hold: Install-Heartbeat.ps1 documented the CP1252
// encoding trap in its header and the identical mistake was made in a sibling file anyway.
{
  const SPAWN = /(?:execFileSync|execFile|spawnSync|spawn)\(\s*"git"/;
  // Reuses the walk this file already performed, which is now .claude-free — see SKIP above.
  const scripts = files.filter((f) => /\.(mjs|js)$/.test(f));
  ok("read the source tree to look for git spawns", scripts.length > 0, scripts.length + " scripts");

  // SELF-EXCLUDED, and the reason is worth stating. This file matched its own pattern -- not because it
  // spawns git, which it does not, but because the CONTROL fixtures below contain the literal text
  // `execFileSync("git", ...)` in order to prove the detector can say yes. A checker's controls necessarily
  // look like the thing it detects, so leaving it in reported "searchable-source.mjs spawns git", which is
  // false and would send the next reader looking for a spawn that is not there.
  const SELF = path.relative(REPO, fileURLToPath(import.meta.url)).replaceAll("\\", "/");
  const spawners = [];
  for (const f of scripts) {
    const rel = path.relative(REPO, f).replaceAll("\\", "/");
    if (rel === SELF) continue;
    const text = await readFile(f, "utf8");
    if (!SPAWN.test(text)) continue;
    spawners.push({ file: rel, text });
  }
  // If this finds nothing the check has stopped asking its question, which is indistinguishable from a
  // clean answer. Both known spawners must be present or the walk/pattern has drifted.
  ok("found the files that spawn git", spawners.length >= 2, spawners.map((s) => s.file).join(", "));
  for (const want of ["test/secret-scan.mjs", "test/ps1-encoding.mjs"])
    ok(`  ${want} is among them`, spawners.some((s) => s.file === want));

  const unscrubbed = spawners.filter((s) => !/gitSafeEnv/.test(s.text));
  ok("every file that spawns git routes its environment through gitSafeEnv",
     unscrubbed.length === 0, unscrubbed.map((s) => s.file).join(", "));

  // CONTROL: the check must be able to say no. Without this, "0 unscrubbed" is the same sentence a broken
  // detector prints.
  const fakeUnscrubbed = [{ file: "x.mjs", text: 'execFileSync("git", ["status"])' }]
    .filter((s) => !/gitSafeEnv/.test(s.text));
  ok("CONTROL: a spawn with no gitSafeEnv is reported", fakeUnscrubbed.length === 1);
  const fakeScrubbed = [{ file: "y.mjs", text: 'execFileSync("git", ["status"], { env: gitSafeEnv() })' }]
    .filter((s) => !/gitSafeEnv/.test(s.text));
  ok("CONTROL: and one that scrubs is not", fakeScrubbed.length === 0);
}

console.log(fail ? `\nSEARCHABLE-SOURCE FAILURES ✗ — ${pass} passed, ${fail} failed`
                 : `\nALL PASS ✓ — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
