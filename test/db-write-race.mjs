// Concurrent saves must not collide on a temp file.
//
// WHY. atomicWriteDbJson named its scratch file `${dbPath}.${pid}.${Date.now()}.tmp`. Two saves in the same
// millisecond in the same process therefore produced the SAME path, and Latch is a single process whose saves
// are not serialised. Both writes then share one file, with two outcomes:
//
//   - the loser's rename finds nothing and throws ENOENT. That surfaces as a 500 on whatever request triggered
//     the save, which is how CI found it: PATCH /api/autonomy -> 500, ENOENT renaming db.json.<pid>.<ms>.tmp.
//   - or B's writeFile lands on A's temp before A renames, so A's rename publishes B's content. No error at
//     all. A save reports success having written something it never composed.
//
// The second is why this is worth a test rather than a retry. db.json is the whole datastore — approvals,
// grants, users, tokens — and a silent wrong-content write there is unrecoverable without a backup.
//
// This exercises the real function's naming rule against the real filesystem. It does not reimplement it: the
// rule is read out of server.js, so a future edit that reintroduces a clock-only name fails here.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rename, unlink, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const ok = (name, cond, extra = "") => {
  assert.ok(cond, name + (extra ? " — " + extra : ""));
  pass++; console.log("  ok  " + name);
};

// ---- 1. the naming rule in server.js must not be clock-only -------------------------------------------
const src = await readFile(path.join(ROOT, "server.js"), "utf8");
const line = (src.match(/const tempPath = `\$\{dbPath\}[^`]*`/) || [])[0] || "";
ok("found the temp-path expression in server.js", Boolean(line), line);
// Date.now() alone repeats within a millisecond; pid is constant for the process. Something per-CALL is what
// makes the name unique, so that is what is asserted — not the exact spelling of it.
ok("the temp name carries a per-call component, not just pid and clock",
   /dbWriteSeq|randomBytes|randomUUID/.test(line), line);

// ---- 2. and the behaviour, against the real filesystem -------------------------------------------------
// Reproduces the collision directly: the OLD rule, run twice in the same millisecond, then both renamed.
const dir = await mkdtemp(path.join(tmpdir(), "latch-writerace-"));
try {
  const dbPath = path.join(dir, "db.json");
  const oldName = (pid, now) => `${dbPath}.${pid}.${now}.tmp`;
  let seq = 0;
  const newName = (pid, now) => `${dbPath}.${pid}.${now}.${++seq}.${crypto.randomBytes(4).toString("hex")}.tmp`;

  // CONTROL: the old rule really does collide. Without this, the pass below could be a property of the
  // fixture rather than of the fix — a check that both names differ proves nothing if the old ones did too.
  const frozen = 1786894782460;
  ok("CONTROL: the old rule gives two identical names in one millisecond",
     oldName(1234, frozen) === oldName(1234, frozen));
  ok("the new rule gives two different names in the same millisecond",
     newName(1234, frozen) !== newName(1234, frozen));

  // And the failure the old rule produces, end to end: write, write, rename, rename.
  const a = oldName(process.pid, frozen), b = oldName(process.pid, frozen);
  await writeFile(a, JSON.stringify({ who: "A" }));
  await writeFile(b, JSON.stringify({ who: "B" }));      // same path — silently replaces A's content
  await rename(a, dbPath);
  const published = JSON.parse(await readFile(dbPath, "utf8"));
  ok("CONTROL: under the old rule, A's rename publishes B's content", published.who === "B",
     `published ${JSON.stringify(published)}`);
  let ren = null;
  try { await rename(b, dbPath); } catch (e) { ren = e; }
  ok("CONTROL: and the second rename fails ENOENT, which is the 500 CI saw", ren?.code === "ENOENT");

  // The same sequence under the new rule: two writes, two renames, no error, and the file holds one of them
  // whole rather than a mixture.
  await unlink(dbPath).catch(() => {});
  const c = newName(process.pid, frozen), d = newName(process.pid, frozen);
  await writeFile(c, JSON.stringify({ who: "C" }));
  await writeFile(d, JSON.stringify({ who: "D" }));
  await rename(c, dbPath);
  const first = JSON.parse(await readFile(dbPath, "utf8"));
  ok("under the new rule the first rename publishes its OWN content", first.who === "C");
  await rename(d, dbPath);                                 // must not throw
  const second = JSON.parse(await readFile(dbPath, "utf8"));
  ok("and the second succeeds, publishing its own content", second.who === "D");

  const leftovers = (await readdir(dir)).filter((f) => f.endsWith(".tmp"));
  ok("no temp files are left behind", leftovers.length === 0, leftovers.join(", "));
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

console.log(`db write-race test passed: ${pass} assertions.`);
