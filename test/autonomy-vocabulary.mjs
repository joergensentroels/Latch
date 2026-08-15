// One vocabulary for the autonomy tiers, and one always-human list — both derived from server.js.
//
// WHY. On 2026-08-15 the four tiers had four different names each, and the two surfaces that sit
// SIDE BY SIDE in the same panel disagreed: the <option> in public/index.html read "Auto-browse" while
// the summary rendered directly beside it, from public/app.js, read "Auto typed tools". The event log
// wrote a third spelling, AGENT-BOUNDARY.md a fourth, and HUMAN-REQUESTS.md documented three tiers when
// there are four. None of that is a coding error anyone could have caught by reading one file — the
// names only disagree when you hold two files open at once, which nothing did.
//
// Worse than the names: the DESCRIPTIONS were wrong in the direction that flatters the code.
// AGENT-BOUNDARY.md said `auto_browse` allowed "navigate/read/extract on HTTPS sites unattended", and
// four separate documents said the top tier released "non-sensitive shell + browser plans". Neither has
// ever been true. And SECURITY.md's always-human list named seven approval types while the code enforced
// fourteen — the code was STRICTER than its own security document, which is the safe direction to be
// wrong in and still a real cost, because that file is what an external reviewer opens first.
//
// So the fix is not a careful re-read. Both facts are already in server.js in machine-readable form: the
// label map, and the type list humanBoundaryReason() checks. This derives them from there and fails when
// any surface drifts. Nothing here is a hand-kept second copy — that is the defect, not the remedy.
//
// It reads source text rather than importing, because server.js starts a listener on import. Every parse
// therefore carries a control that it found something real, since a regex that silently matches nothing
// makes every "must contain" assertion below pass over an empty set.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  :: " + detail : ""}`); }
};

const server = read("server.js");
const appJs = read("public/app.js");
const html = read("public/index.html");

// ---- what the code says ---------------------------------------------------------------------------
const modes = [...(server.match(/const autonomyModes = \[([^\]]*)\]/)?.[1] || "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
ok("parsed the canonical autonomy modes out of server.js", modes.length === 4, modes.join(", "));
ok("  and they are the four expected stored values",
  ["default_permissions", "auto_review", "auto_browse", "full_access"].every((m) => modes.includes(m)), modes.join(", "));

// The label map, taken from server.js's autonomyModeLabel — the one definition every other surface copies.
const labelBlock = server.match(/function autonomyModeLabel\(mode\) \{[\s\S]*?\n\}/)?.[0] || "";
const labels = Object.fromEntries([...labelBlock.matchAll(/(\w+):\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
ok("parsed server.js's label map", Object.keys(labels).length === 4, JSON.stringify(labels));
ok("  every stored mode has a label", modes.every((m) => labels[m]), JSON.stringify(labels));

// ---- the three surfaces that must agree with it ----------------------------------------------------
const appBlock = appJs.match(/function autonomyModeLabel\(value\) \{[\s\S]*?\n\}/)?.[0] || "";
const appLabels = Object.fromEntries([...appBlock.matchAll(/(\w+):\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
ok("parsed public/app.js's label map", Object.keys(appLabels).length === 4, JSON.stringify(appLabels));

const options = Object.fromEntries([...html.matchAll(/<option value="(default_permissions|auto_review|auto_browse|full_access)">([^<]+)<\/option>/g)].map((m) => [m[1], m[2]]));
ok("parsed the autonomy <option> texts from public/index.html", Object.keys(options).length === 4, JSON.stringify(options));

for (const mode of modes) {
  // This is the assertion the whole file exists for: the dropdown and the label rendered beside it.
  ok(`"${mode}" is named the same in index.html and app.js`, options[mode] === appLabels[mode],
    `dropdown "${options[mode]}" vs summary "${appLabels[mode]}"`);
  ok(`  …and the same again in server.js (the event log)`, labels[mode] === appLabels[mode],
    `server "${labels[mode]}" vs summary "${appLabels[mode]}"`);
}

// The two names that taught the wrong model. They must not come back anywhere a user reads.
const RETIRED = ["Auto-browse", "Full auto"];
const SURFACES = ["public/index.html", "public/app.js"];
for (const f of SURFACES) {
  const text = read(f);
  for (const bad of RETIRED) ok(`${f} does not use the retired name "${bad}"`, !text.includes(bad));
}

// ---- the documents name all four, by the same names ------------------------------------------------
// NOT "the label appears somewhere in the file". Four of the assertions in the first version of this
// file were VACUOUS for exactly that reason, and the thing satisfying them was the prose I had just
// written to explain the fix: deleting a tier from AGENT-BOUNDARY.md's table left the check green
// because a note further down still mentioned the name. A doc must pair the LABEL with the BACKTICKED
// STORED VALUE, which is a shape explanatory prose does not accidentally produce.
const paired = (text, label, value) => new RegExp(`\\*\\*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\*\\*[^\\n]{0,12}\`${value}\``).test(text);
const TIER_DOCS = ["AGENT-BOUNDARY.md", "AUTONOMY.md", "HUMAN-REQUESTS.md", "SECURITY.md"];
for (const doc of TIER_DOCS) {
  const text = read(doc);
  const missing = modes.filter((m) => !paired(text, labels[m], m));
  ok(`${doc} pairs all four tier names with their stored values`, missing.length === 0,
    missing.map((m) => `${labels[m]} (${m})`).join(", ") + " unpaired");
}
// The control for the pairing matcher, since a regex that matches nothing would report every document
// as fine forever. Both halves: a real pairing matches, and a near-miss does not.
ok("the pairing matcher accepts a real pairing", paired("- **Auto typed tools** (`auto_browse`): x", "Auto typed tools", "auto_browse"));
ok("  and rejects a label whose value is somewhere else entirely",
  !paired("**Auto typed tools** is discussed below, and `auto_browse` is its value", "Auto typed tools", "auto_browse"));
ok("  and is not satisfied by a longer label that merely starts the same way",
  !paired("- **Auto typed toolsX** (`auto_browseX`): x", "Auto typed tools", "auto_browse"),
  "substring matching is how the first version of this check passed on a deleted tier");

// ---- the always-human list, against the code that enforces it --------------------------------------
// Parsed out of humanBoundaryReason's type check. SECURITY.md must name every one, because a control the
// code enforces and the security document omits is a control nobody can credit you for.
const boundaryFn = server.match(/function humanBoundaryReason\(approval\) \{[\s\S]*?\n\}/)?.[0] || "";
const types = [...(boundaryFn.match(/if \(\[([^\]]*)\]\.includes\(approval\.type\)\)/)?.[1] || "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
ok("parsed the always-human approval types out of humanBoundaryReason()", types.length >= 10, `${types.length} types`);
ok("  the parse really is that list (purchase and credential are in it)",
  types.includes("purchase") && types.includes("credential"), types.join(","));

// Scoped to the ENUMERATION LINE, not to the file. Checking the whole file was vacuous: removing
// `task_continue` from the list left the check green because the paragraph explaining that it had been
// missing still named it. The line is found structurally — many backticked identifiers joined by " · " —
// so it cannot be satisfied by a sentence that happens to mention a type.
const security = read("SECURITY.md");
const listLine = security.split("\n").find((l) => (l.match(/`[a-z_]+`/g) || []).length >= 10 && l.includes(" · "));
ok("found SECURITY.md's always-human enumeration line", !!listLine, "no line carries the type list");
const unlisted = types.filter((t) => !(listLine || "").includes("`" + t + "`"));
ok("SECURITY.md's list names every approval type the code holds on the human boundary", !!listLine && unlisted.length === 0,
  "enforced but unlisted: " + unlisted.join(", "));
ok("  and the list names nothing the code does not enforce",
  !!listLine && (listLine.match(/`([a-z_]+)`/g) || []).every((t) => types.includes(t.replace(/`/g, ""))),
  "listed but not enforced: " + (listLine || "").match(/`([a-z_]+)`/g)?.filter((t) => !types.includes(t.replace(/`/g, ""))).join(", "));

// The other half of that boundary, which is not a type at all and is the easier half to forget.
ok("SECURITY.md still records the two non-type human boundaries (sensitive, and credential-ish browser plans)",
  /`sensitive`/.test(security) && /login\/credential/.test(security));

// ---- the claim that was false in four documents at once ---------------------------------------------
ok("the code really does refuse arbitrary execution before any tier is consulted",
  /function isArbitraryExecution\(approval\) \{[\s\S]*?\["shell", "browser"\]\.includes\(approval\.executionMode\)/.test(server));

const CLAIM_DOCS = ["AGENT-BOUNDARY.md", "AUTONOMY.md", "HUMAN-REQUESTS.md", "README.md", "OPENCLAW-WORKER.md", "SECURITY.md"];

// POSITIVE half: each document must SAY the invariant. Detecting a false English sentence is an
// unbounded problem and the first attempt at it was vacuous — a line-level "does it also say never"
// exclusion was satisfied by the correction sentence sitting in the same paragraph. Asserting the true
// statement is present is bounded, exact, and cannot be satisfied by accident.
const STATES_INVARIANT = /\b(shell|arbitrary)\b[^.\n]{0,120}\bnever auto-approved\b|\bnever auto-approved\b[^.\n]{0,120}\b(shell|any tier)\b|no autonomy tier auto-approves them/i;
for (const doc of CLAIM_DOCS) {
  ok(`${doc} states that shell/browser plans are never auto-approved at any tier`, STATES_INVARIANT.test(read(doc)));
}
ok("the invariant detector can fail", !STATES_INVARIANT.test("Shell plans run on the VM through bash -lc with a timeout."));

// NEGATIVE half, and its limit is stated rather than implied: this is a REGRESSION guard against the
// exact wordings that were wrong, not a general detector of false claims. Someone reverting a paragraph
// reverts it to the words it had, which is what this catches.
const RETIRED_CLAIMS = [
  "navigate/read/extract on HTTPS sites unattended",
  "Non-sensitive shell + browser plans",
  "can also auto-approve non-sensitive `shell` and `browser` execution plans",
  "can release non-sensitive VM shell/browser plans",
  "Full access can auto-run non-sensitive approved VM plans",
];
for (const doc of [...CLAIM_DOCS, "public/app.js"]) {
  const text = read(doc);
  const found = RETIRED_CLAIMS.filter((c) => text.includes(c));
  ok(`${doc} has not reverted to a retired description of what a tier releases`, found.length === 0, found.join(" | "));
}
ok("the retired-claim list is non-empty and matches literally",
  RETIRED_CLAIMS.length === 5 && "x Non-sensitive shell + browser plans y".includes(RETIRED_CLAIMS[1]),
  "an empty or non-matching blocklist passes on every file forever");

console.log(fail ? `\nFAILURES — ${pass} passed, ${fail} failed` : `\nALL PASS — ${pass} passed, 0 failed`);
process.exitCode = fail ? 1 : 0;
