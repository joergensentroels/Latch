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
const SKIP = new Set(["node_modules", ".git", "data", "data-dev", "backups", "logs", "dist", "coverage"]);

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

console.log(fail ? `\nSEARCHABLE-SOURCE FAILURES ✗ — ${pass} passed, ${fail} failed`
                 : `\nALL PASS ✓ — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
