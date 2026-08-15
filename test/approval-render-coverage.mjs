// Approval display/execution coverage — the generalisation of SECURITY-FINDINGS-2026-07.md F1.
//
// F1 was "the operator approves one field and the host executes a different one". It was fixed for
// SHELL plans only, by deriving the displayed commands from `executionPlan.commands`. The same split
// was still open for every other executable type: the host accepted, stored and acted on `emailTo`,
// `emailBody`, `mcpArgs`, `githubPrFiles`, `githubIssueTitle`, `githubIssueBody` and
// `campaignRecipients`, and `public/app.js` rendered NONE of them — the card showed the worker's
// free-text `title` and `details` instead. The worker wrote both the prose the operator read and the
// payload the host ran, and seven of the eighteen accepted types did not even have a label.
//
// A fix alone would not survive: the next approval type added to the server arrives with the same gap
// and nothing says so. So this is a gate, not a note. Both sides are derived from source — there is no
// hand-kept list of types or fields to fall out of date:
//
//   accepted types   <- server.js  `const approvalTypes = [...]`
//   per-type fields  <- server.js  the `const approval = {...}` creation record: any property whose
//                                  value is gated on `approvalType` is worker-supplied input for
//                                  exactly the types named in that gate
//   executed fields  <- server.js  every `approval.<field>` READ reachable from
//                                  handleApprovedApprovalSideEffects (assignments are outputs the
//                                  host writes after acting, not inputs, so they are excluded)
//   labelled types   <- public/app.js  formatApprovalType + simpleApprovalType label maps
//   styled types     <- public/styles.css  `.type-pill.<type>` selectors
//
// The display check is not a grep for the field name. `public/app.js`'s approval summaries are pure
// string builders, so this file EXECUTES them in a vm and renders each type twice, changing exactly
// one field between the two runs. If the two outputs are identical, that field does not reach the
// operator's screen — whatever the source appears to say. That is the F1 property stated directly:
// what is displayed must be derived from what will execute.
//
// The extractors are self-tested (`assertScannerWorks`) and floored for non-vacuity, because an
// extractor that quietly returns an empty set turns every assertion here into a tautology — the exact
// shape of failure this file exists to prevent.

import { readFile } from "node:fs/promises";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

// Bookkeeping the execution path touches that is NOT an action payload: identity, routing pointers
// and the host's own decision record. This is the one place a field can be exempted from "the
// operator must see it", so adding to it is a deliberate, reviewable act. Say why each entry is here.
const NON_PAYLOAD_FIELDS = new Set([
  "id",          // host-minted approval id
  "userId",      // owner of the approval, not part of the action
  "taskId",      // routing pointer back to the originating task
  "messageId",   // routing pointer back to the originating message
  "status",      // the decision itself, shown as a badge
  "reviewedAt",  // decision timestamp
  "decisionMode" // human vs auto, shown as a pill
]);

// Fields whose element shape cannot be inferred from their empty default in the creation record.
// A structured field added without an entry here fails loudly (its fixture renders as nothing),
// rather than passing quietly.
const FIXTURE_OVERRIDES = {
  githubPrFiles: [
    [{ path: "alpha.txt", content: "alpha file content" }],
    [{ path: "beta.txt", content: "beta file content" }]
  ]
};

// ---------------------------------------------------------------------------------------------
// Source scanning primitives
// ---------------------------------------------------------------------------------------------

// Marks every character that is CODE (i.e. not inside a string, comment, regex, or the literal text
// of a template). The interior of a template's `${...}` is code, and its braces are marked, so brace
// counting stays balanced across template boundaries.
function codeMask(text) {
  const mask = new Uint8Array(text.length);
  const stack = [{ template: false, brace: 0 }];
  let i = 0;
  while (i < text.length) {
    const top = stack[stack.length - 1];
    const ch = text[i];
    if (top.template) {
      if (ch === "\\") { i += 2; continue; }
      if (ch === "`") { stack.pop(); i += 1; continue; }
      if (ch === "$" && text[i + 1] === "{") {
        mask[i + 1] = 1;
        stack.push({ template: false, brace: 0 });
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') { i = skipString(text, i); continue; }
    if (ch === "`") { stack.push({ template: true }); i += 1; continue; }
    if (ch === "/" && isRegexStart(text, i)) { i = skipRegex(text, i); continue; }
    if (ch === "{") top.brace += 1;
    if (ch === "}") {
      if (top.brace === 0 && stack.length > 1) {
        mask[i] = 1;
        stack.pop();
        i += 1;
        continue;
      }
      top.brace -= 1;
    }
    mask[i] = 1;
    i += 1;
  }
  return mask;
}

function skipString(text, start) {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") { i += 2; continue; }
    if (text[i] === quote) return i + 1;
    if (text[i] === "\n") return i;
    i += 1;
  }
  return i;
}

function skipRegex(text, start) {
  let i = start + 1;
  let inClass = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === "\n") return start + 1;
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) return i + 1;
    i += 1;
  }
  return i;
}

// Standard "can a regex literal start here" heuristic: after an operator or opening delimiter it is a
// regex, after a value it is division.
function isRegexStart(text, index) {
  const before = text.slice(Math.max(0, index - 48), index).replace(/\s+$/, "");
  if (!before) return true;
  const last = before[before.length - 1];
  if ("(,=:[!&|?{};+-*%~^<>".includes(last)) return true;
  const word = (before.match(/[A-Za-z_$][\w$]*$/) || [""])[0];
  return ["return", "typeof", "case", "in", "of", "new", "delete", "void", "do", "else", "yield", "await"].includes(word);
}

function matchBrace(text, mask, openIndex) {
  assert.equal(text[openIndex], "{", `matchBrace: expected "{" at ${openIndex}`);
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (!mask[i]) continue;
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`matchBrace: no match for "{" at ${openIndex}`);
}

// name -> { body, source } for every `function name(...) {}` declaration.
function functionBodies(text, mask) {
  const found = new Map();
  for (const match of text.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const parenIndex = text.indexOf("(", match.index + match[0].length - 1);
    if (parenIndex === -1 || !mask[parenIndex]) continue;
    let depth = 0;
    let i = parenIndex;
    for (; i < text.length; i += 1) {
      if (!mask[i]) continue;
      if (text[i] === "(") depth += 1;
      else if (text[i] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const open = text.indexOf("{", i);
    if (open === -1) continue;
    const close = matchBrace(text, mask, open);
    const declaration = text.indexOf("function", match.index);
    found.set(match[1], { body: text.slice(open, close + 1), source: text.slice(declaration, close + 1) });
  }
  return found;
}

// Split an object/array literal into its top-level entries.
function splitTopLevel(text) {
  const mask = codeMask(text);
  const parts = [];
  let depth = 0;
  let start = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (!mask[i]) continue;
    const ch = text[i];
    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") {
      depth -= 1;
      if (depth === 0) {
        parts.push(text.slice(start, i));
        break;
      }
    } else if (ch === "," && depth === 1) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  return parts.map((part) => part.trim()).filter(Boolean);
}

// Entries in the creation record are documented in place, so a leading comment must not be mistaken
// for part of the property name.
function stripLeadingComments(text) {
  let out = text.trimStart();
  for (;;) {
    if (out.startsWith("//")) {
      const nl = out.indexOf("\n");
      out = nl === -1 ? "" : out.slice(nl + 1).trimStart();
      continue;
    }
    if (out.startsWith("/*")) {
      const end = out.indexOf("*/");
      out = end === -1 ? "" : out.slice(end + 2).trimStart();
      continue;
    }
    return out;
  }
}

// Property name and value expression of one object-literal entry, shorthand included.
function propertyParts(rawEntry) {
  const entry = stripLeadingComments(rawEntry);
  const mask = codeMask(entry);
  let depth = 0;
  for (let i = 0; i < entry.length; i += 1) {
    if (!mask[i]) continue;
    const ch = entry[i];
    if ("{([".includes(ch)) depth += 1;
    else if ("})]".includes(ch)) depth -= 1;
    else if (ch === ":" && depth === 0) {
      return { key: entry.slice(0, i).trim().replace(/^["']|["']$/g, ""), value: entry.slice(i + 1).trim() };
    }
  }
  const key = entry.trim();
  return { key, value: key };
}

// `approval.<field>` occurrences that are READS. `approval.x = ...` is an output the host writes
// after acting, not an input the operator needs before deciding.
function approvalFieldReads(text) {
  const fields = new Set();
  for (const match of text.matchAll(/\bapproval\.([A-Za-z_$][\w$]*)/g)) {
    const after = text.slice(match.index + match[0].length);
    if (/^\s*=(?![=>])/.test(after)) continue;
    fields.add(match[1]);
  }
  return fields;
}

// Functions reachable from `entries`. When `argument` is given, only calls handed that argument are
// followed, which keeps the walk on the approval's own path instead of the whole module.
function reachableFrom(functions, entries, argument) {
  const seen = new Set();
  const queue = [...entries];
  const wanted = argument ? new RegExp(`\\b${argument}\\b`) : null;
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name) || !functions.has(name)) continue;
    seen.add(name);
    for (const call of functions.get(name).body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(([^()]*)\)/g)) {
      if (!wanted || wanted.test(call[2])) queue.push(call[1]);
    }
  }
  return seen;
}

function quotedStrings(text) {
  return [...text.matchAll(/"([^"\\]*)"|'([^'\\]*)'/g)].map((match) => match[1] ?? match[2]);
}

function labelMapKeys(functions, functionName) {
  const entry = functions.get(functionName);
  assert.ok(entry, `${functionName} not found in public/app.js`);
  const mask = codeMask(entry.body);
  const open = entry.body.indexOf("{", entry.body.indexOf("const labels"));
  assert.ok(open !== -1, `${functionName} has no labels map`);
  const map = entry.body.slice(open, matchBrace(entry.body, mask, open) + 1);
  return new Set(splitTopLevel(map).map((part) => propertyParts(part).key));
}

function report(label, missing, detail) {
  if (!missing.length) return;
  failures.push(`${label}\n${missing.map((item) => `    - ${item}`).join("\n")}\n  ${detail}`);
}

// ---------------------------------------------------------------------------------------------
// Scanner self-test: an extractor that reads nothing would make every check below vacuous.
// ---------------------------------------------------------------------------------------------

function assertScannerWorks() {
  const sample = [
    "function outer(a = {}, b) {",
    "  const s = \"} not a brace\";",
    "  const r = /[}{]/g;",
    "  // } not a brace",
    "  /* } not a brace */",
    "  const t = `text } ${ inner({ deep: 1 }) } more`;",
    "  return approval.shown + approval.alsoShown;",
    "}",
    "function after() { return 1; }"
  ].join("\n");
  const mask = codeMask(sample);
  const found = functionBodies(sample, mask);
  assert.ok(found.has("outer") && found.has("after"), "scanner self-test: both functions must be found");
  assert.ok(found.get("outer").body.includes("alsoShown"), "scanner self-test: body must reach the end of the function");
  assert.ok(!found.get("outer").body.includes("function after"), "scanner self-test: body must stop at the closing brace");
  assert.ok(found.get("outer").source.startsWith("function outer"), "scanner self-test: source must include the declaration");
  assert.deepEqual([...approvalFieldReads(found.get("outer").body)].sort(), ["alsoShown", "shown"]);
  // Writes are outputs, not inputs. `==` and `=>` must not be mistaken for assignment.
  assert.deepEqual([...approvalFieldReads("approval.written = 1; approval.read === 2; approval.arrow => 3;")].sort(), ["arrow", "read"]);
  const object = "{ plain: 1, gated: type === \"x\" ? a : b, nested: { inner: \"a, b\" },\n// documented\ncommented: 2, shorthand }";
  assert.deepEqual(
    splitTopLevel(object).map((entry) => propertyParts(entry).key),
    ["plain", "gated", "nested", "commented", "shorthand"],
    "scanner self-test: top-level split"
  );
  // The call walk must follow the named argument only, or "reachable from the renderer" degrades to
  // "anywhere in the file" and the whole render-path derivation becomes meaningless.
  const callSample = "function root() { carries(approval); unrelated(other); }\nfunction carries(a) { return 1; }\nfunction unrelated(a) { return 2; }";
  const callFns = functionBodies(callSample, codeMask(callSample));
  assert.deepEqual([...reachableFrom(callFns, ["root"], "approval")].sort(), ["carries", "root"]);
}

assertScannerWorks();

// ---------------------------------------------------------------------------------------------
// Derive the two sides
// ---------------------------------------------------------------------------------------------

const serverSource = await readFile(path.join(root, "server.js"), "utf8");
const appSource = await readFile(path.join(root, "public", "app.js"), "utf8");
const cssSource = await readFile(path.join(root, "public", "styles.css"), "utf8");

const serverMask = codeMask(serverSource);
const appMask = codeMask(appSource);
const serverFunctions = functionBodies(serverSource, serverMask);
const appFunctions = functionBodies(appSource, appMask);

// 1. The types the server accepts.
const typesDeclaration = serverSource.match(/\bconst approvalTypes\s*=\s*\[[^\]]*\]/);
assert.ok(typesDeclaration, "server.js: could not find `const approvalTypes = [...]`");
const acceptedTypes = quotedStrings(typesDeclaration[0]);
assert.ok(acceptedTypes.length >= 10, `server.js: only ${acceptedTypes.length} approval types parsed — the extractor is broken`);

// 2. The worker-supplied fields the server accepts for each type. A property gated on `approvalType`
//    exists only for the types named in that gate; its default also tells us the field's shape.
const recordOpen = serverSource.indexOf("{", serverSource.indexOf("const approval = {"));
assert.ok(recordOpen > 0, "server.js: could not find the `const approval = {...}` creation record");
const recordText = serverSource.slice(recordOpen, matchBrace(serverSource, serverMask, recordOpen) + 1);
const constDeclarations = new Map(
  [...serverSource.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g)].map((match) => [match[1], match[2]])
);

const fieldsByType = new Map(acceptedTypes.map((type) => [type, new Set()]));
const fieldShape = new Map();
let gatedPairs = 0;
for (const entry of splitTopLevel(recordText)) {
  const { key, value } = propertyParts(entry);
  // Shorthand properties carry the gate on their `const` declaration instead of in the record.
  const expression = /\bapprovalType\b/.test(value) ? value : (constDeclarations.get(value.trim()) || "");
  if (!/\bapprovalType\b/.test(expression)) continue;
  let gated = quotedStrings(expression).filter((literal) => fieldsByType.has(literal));
  if (!gated.length) {
    // The gate was delegated to a helper, e.g. githubApprovalRepoName(approvalType, ...).
    for (const call of expression.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      const helper = serverFunctions.get(call[1]);
      if (helper) gated = gated.concat(quotedStrings(helper.body).filter((literal) => fieldsByType.has(literal)));
    }
  }
  if (!gated.length) continue;
  fieldShape.set(key, (expression.match(/:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\d+|\[\s*\]|\{\s*\}|false|true)\s*$/) || [, '""'])[1]);
  for (const type of new Set(gated)) {
    fieldsByType.get(type).add(key);
    gatedPairs += 1;
  }
}

// 3. The fields the host reads while executing an approved approval.
const executionEntry = "handleApprovedApprovalSideEffects";
assert.ok(serverFunctions.has(executionEntry), `server.js: ${executionEntry} not found`);
const executedFields = new Set();
for (const name of reachableFrom(serverFunctions, [executionEntry], "approval")) {
  for (const field of approvalFieldReads(serverFunctions.get(name).body)) executedFields.add(field);
}

// 4. What the operator's screen shows. `renderedFields` is the coarse backstop for check 6; the
//    precise per-type answer comes from actually rendering, below.
const renderEntries = ["renderApprovals", "renderSimpleApprovals"];
for (const entry of renderEntries) assert.ok(appFunctions.has(entry), `public/app.js: ${entry} not found`);
const renderPath = [...reachableFrom(appFunctions, renderEntries, "approval")]
  .map((name) => appFunctions.get(name).body)
  .join("\n");
const renderedFields = approvalFieldReads(renderPath);

const styledTypes = new Set([...cssSource.matchAll(/\.type-pill\.([A-Za-z_][\w-]*)\b/g)].map((match) => match[1]));

// ---------------------------------------------------------------------------------------------
// Non-vacuity floors — prove each derived set is still being populated
// ---------------------------------------------------------------------------------------------

assert.ok(gatedPairs >= 20, `only ${gatedPairs} type-gated fields parsed from the creation record — the extractor is broken, not the code`);
assert.ok(executedFields.size >= 10, `only ${executedFields.size} executed fields found from ${executionEntry} — the call walk is broken`);
assert.ok(renderedFields.size >= 20, `only ${renderedFields.size} rendered fields found — the render-path walk is broken`);
assert.ok(styledTypes.size >= 5, `only ${styledTypes.size} type-pill rules found — the CSS scan is broken`);
// The fields named in the F1 generalisation must still be recognised as worker-supplied input. If a
// refactor moves them out of the creation record this fires, rather than the check going quiet.
//
// This is also the ONLY thing standing between a re-narrowed gate and silence. The per-type render
// loop below skips any type with no gated fields (`if (!fields.size) continue`), which is right for
// types that carry no payload -- but it means narrowing a gate until a type has none left removes it
// from coverage instead of failing it, and its summary branch quietly becomes dead code. That is how
// email_thread_continue lost `emailTo`: the host blanked the one field naming the contact, and the
// worker, which reads it back to decide WHICH thread to un-pause, resumed nothing at all.
for (const [type, field] of [
  ["email_campaign", "emailBody"],
  ["email_campaign", "campaignRecipients"],
  ["email_thread_continue", "emailTo"],
  ["mcp_tool_call", "mcpArgs"],
  ["github_pull_request", "githubPrFiles"],
  ["github_issue", "githubIssueBody"]
]) {
  assert.ok(fieldsByType.get(type)?.has(field), `extractor regression: ${field} is no longer derived as a ${type} input field`);
}

// ---------------------------------------------------------------------------------------------
// Render the summaries for real, and vary one field at a time
// ---------------------------------------------------------------------------------------------

const summaryEntry = "approvalExecutionSummary";
assert.ok(appFunctions.has(summaryEntry), `public/app.js: ${summaryEntry} not found — the per-type summary dispatch is gone`);
const sandbox = vm.createContext({ state: { disclosureState: {} }, Intl, Date, JSON, Object, Array, String, Boolean, Number, Math });
vm.runInContext(
  [...reachableFrom(appFunctions, [summaryEntry], "")].map((name) => appFunctions.get(name).source).join("\n\n"),
  sandbox,
  { filename: "public/app.js (summary closure)" }
);

// Two distinct, plausible values per shape. Strings carry an "@" so that address-shaped fields stay
// address-shaped; nothing here is real data.
function fixtureValues(field) {
  if (FIXTURE_OVERRIDES[field]) return FIXTURE_OVERRIDES[field];
  const shape = fieldShape.get(field) || '""';
  if (shape === "true" || shape === "false") return [true, false];
  if (/^-?\d+$/.test(shape)) return [11, 22];
  if (shape.startsWith("[")) return [["alpha@example.test"], ["beta@example.test", "gamma@example.test"]];
  if (shape.startsWith("{")) return [{ alphaKey: "alpha argument" }, { betaKey: "beta argument" }];
  return ["alpha@example.test", "beta@example.test"];
}

const baseFixture = { id: "approval_fixture", title: "Fixture approval", details: "Fixture details", status: "pending" };
for (const [field] of fieldShape) baseFixture[field] = fixtureValues(field)[0];

function render(approval) {
  return String(vm.runInContext(`${summaryEntry}(${JSON.stringify(approval)})`, sandbox) || "");
}

const unrendered = [];
const missingSummary = [];
for (const [type, fields] of fieldsByType) {
  if (!fields.size) continue;
  const baseline = render({ ...baseFixture, type });
  if (!baseline.trim()) {
    missingSummary.push(`${type} (${fields.size} worker-supplied field${fields.size === 1 ? "" : "s"} accepted)`);
    continue;
  }
  for (const field of [...fields].sort()) {
    const [, beta] = fixtureValues(field);
    if (render({ ...baseFixture, type, [field]: beta }) === baseline) unrendered.push(`${type}: approval.${field}`);
  }
}

// ---------------------------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------------------------

const proLabels = labelMapKeys(appFunctions, "formatApprovalType");
const simpleLabels = labelMapKeys(appFunctions, "simpleApprovalType");

report(
  "Approval types the server accepts but formatApprovalType does not label (they render as \"Other\"):",
  acceptedTypes.filter((type) => !proLabels.has(type)),
  "Add them to formatApprovalType in public/app.js."
);
report(
  "Approval types the server accepts but simpleApprovalType does not label (they render as \"Review\"):",
  acceptedTypes.filter((type) => !simpleLabels.has(type)),
  "Add them to simpleApprovalType in public/app.js."
);
report(
  "Approval types with no .type-pill rule in public/styles.css:",
  acceptedTypes.filter((type) => !styledTypes.has(type)),
  "Add a .type-pill.<type> rule so the pill's colour matches the action's consequence."
);
report(
  `Approval types whose payload the host acts on but ${summaryEntry} renders nothing for:`,
  missingSummary,
  "Add a branch and a summary function in public/app.js."
);
report(
  "Fields the server accepts from the worker but which change nothing on the operator's screen:",
  unrendered,
  "Rendering these two approvals produced byte-identical HTML, so the operator approves the worker's\n  prose while the host acts on this field (SECURITY-FINDINGS-2026-07.md F1)."
);
report(
  "Fields the host reads while executing an approved approval but that appear nowhere on the render path:",
  [...executedFields].filter((field) => !NON_PAYLOAD_FIELDS.has(field) && !renderedFields.has(field)).sort().map((field) => `approval.${field}`),
  "Render it on the approval card, or justify it in NON_PAYLOAD_FIELDS in this file."
);

if (failures.length) {
  console.error("Approval render coverage failed:\n");
  for (const failure of failures) console.error(`  ${failure}\n`);
  process.exit(1);
}

const checkedFields = [...fieldsByType.values()].reduce((total, fields) => total + fields.size, 0);
console.log(
  `Approval render coverage passed: ${acceptedTypes.length} types labelled and styled, ` +
  `${checkedFields} type-gated fields proved to change the rendered card, ` +
  `${executedFields.size} executed fields present on the render path.`
);
