// The Latch Network UI switch, end to end: LATCH_NETWORK_ENABLED on the host -> `networkEnabled` in
// both state payloads -> the credits tab appearing in the client's tab list.
//
// This exists because the switch used to be `const NETWORK_ENABLED = false` in public/app.js. A
// hardcoded constant is at least honest about its value; a runtime path can silently stop working,
// and nothing else in the suite would notice. The whole rest of `npm test` passes with every line of
// the wiring deleted, because no other test sets the variable or renders a tab.
//
// Both directions are asserted, so each is the other's control: "no credits tab" would also be the
// output of an extractor that returned nothing, or a tab list that lost the credits entry entirely.
// The ON case is what makes the OFF case mean something.

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = await mkdtemp(path.join(tmpdir(), "latch-netflag-"));
const operatorToken = "op_netflag";
const operatorHeaders = { authorization: `Bearer ${operatorToken}` };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let child = null;
let stderr = "";
let baseUrl = "";

function startServer(extraEnv) {
  const port = String(31000 + Math.floor(Math.random() * 2000));
  baseUrl = `http://127.0.0.1:${port}`;
  stderr = "";
  child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      HOST: "127.0.0.1",
      PORT: port,
      OPERATOR_TOKEN: operatorToken,
      AGENT_TOKEN: "agent_netflag",
      LATCH_ENABLE_DEV_LOGIN: "1",
      LATCH_LOG: "off",
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
}

async function stopServer() {
  if (!child) return;
  const current = child;
  child = null;
  current.kill("SIGTERM");
  await new Promise((resolve) => { current.on("exit", resolve); setTimeout(resolve, 3000); });
}

// Returns the STATUS alongside the body. It used to return the parsed body alone, so a 401, a 429 or a 500 was
// handed to the assertions as an ordinary object — and every error body Latch sends lacks the field under test,
// so the failure read "networkEnabled: expected false, actual undefined". That is a request which never
// succeeded, wearing the costume of a payload that answered the question and said no. CI has been red on it
// since 2026-08-15 with nothing in the output naming a cause.
async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { unparsed: text.slice(0, 300) }; }
  return { status: response.status, body };
}

// Fails with what the server actually said. "undefined" names neither the status nor the reason; this names both.
function must200(what, res) {
  assert.ok(res.status >= 200 && res.status < 300,
    `${what} must answer 2xx before its payload means anything — got HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body;
}

async function waitForHealth() {
  const deadline = Date.now() + 10000;
  let last = "no attempt completed";
  while (Date.now() < deadline) {
    try {
      const health = await request("/api/health");
      if (health.body.ok) return;
      last = `HTTP ${health.status}: ${JSON.stringify(health.body).slice(0, 200)}`;
    } catch (e) { last = String(e?.message || e); }
    // Outside the catch. It used to delay only when the fetch THREW, so a server that answered without ok
    // spun this loop with no pause for the full ten seconds — thousands of requests, and a report of
    // "did not become healthy" that never said what it had been answering.
    await delay(120);
  }
  throw new Error(`server did not become healthy — last: ${last}\nstderr:\n${stderr}`);
}

// Both payloads, because the operator console and the Compass user UI read different endpoints and
// the flag has to reach both. A user session is needed for the second one.
async function readBothPayloads() {
  const operatorState = must200("GET /api/state", await request("/api/state", { headers: operatorHeaders }));
  const session = must200("POST /api/me/session/dev", await request("/api/me/session/dev", {
    method: "POST",
    body: { email: "netflag@example.com", displayName: "Net Flag" }
  }));
  assert.ok(String(session.token || "").startsWith("user_"), `dev session should return a user token, got ${JSON.stringify(session).slice(0, 200)}`);
  const userState = must200("GET /api/me/state",
    await request("/api/me/state", { headers: { authorization: `Bearer ${session.token}` } }));
  return { operatorState, userState };
}

try {
  // ===========================================================================================
  // 1. Host default: the variable is unset, so the network UI is off.
  // ===========================================================================================
  startServer({});
  await waitForHealth();
  let payloads = await readBothPayloads();

  assert.equal(payloads.operatorState.networkEnabled, false,
    "with LATCH_NETWORK_ENABLED unset, /api/state must report networkEnabled false");
  assert.equal(payloads.userState.networkEnabled, false,
    "with LATCH_NETWORK_ENABLED unset, /api/me/state must report networkEnabled false");
  // The field has to be PRESENT, not merely falsy. `undefined == false` would let a payload that
  // never carried the flag pass the two assertions above.
  assert.ok("networkEnabled" in payloads.operatorState,
    "/api/state must actually carry the networkEnabled field, not just fail to contradict it");
  assert.ok("networkEnabled" in payloads.userState,
    "/api/me/state must actually carry the networkEnabled field, not just fail to contradict it");

  await stopServer();

  // ===========================================================================================
  // 2. Operator turns it on at the host. No source edit anywhere.
  // ===========================================================================================
  startServer({ LATCH_NETWORK_ENABLED: "1" });
  await waitForHealth();
  payloads = await readBothPayloads();

  assert.equal(payloads.operatorState.networkEnabled, true,
    "LATCH_NETWORK_ENABLED=1 must reach /api/state — this is the whole point of moving the switch off a source constant");
  assert.equal(payloads.userState.networkEnabled, true,
    "LATCH_NETWORK_ENABLED=1 must reach /api/me/state too");

  await stopServer();

  // ===========================================================================================
  // 3. The client half: the tab list follows the flag.
  //
  // Pulled out of public/app.js and RUN, rather than grepped for. The failure this catches is the
  // one that actually happened while making this change: simpleTabs/proTabs became functions and
  // two call sites kept using them as arrays, which no server-side check could ever see.
  // ===========================================================================================
  const appSource = await readFile(path.join(root, "public", "app.js"), "utf8");
  const lines = appSource.split("\n");

  // Markers here are things the line has whatever the flag does (a tab that is always present, the
  // name being assigned). Marking on "credits" instead would make a legitimate removal of the
  // credits entry report itself as a broken extractor, which is a confusing way to learn that the
  // gating changed — that belongs to the behavioural assertions further down.
  function declaration(prefix, marker) {
    const line = lines.find((item) => item.trim().startsWith(prefix));
    assert.ok(line, `public/app.js: no line starting ${JSON.stringify(prefix)} — the tab gating has been renamed or removed`);
    assert.ok(line.includes(marker),
      `public/app.js: found ${JSON.stringify(prefix)} but it does not contain ${JSON.stringify(marker)} — the extractor is broken, not the app`);
    return line.trim();
  }

  function topLevelFunction(name, marker) {
    const start = lines.findIndex((line) => line.startsWith(`function ${name}(`));
    assert.ok(start !== -1, `public/app.js: function ${name} not found`);
    const end = lines.findIndex((line, index) => index > start && line === "}");
    assert.ok(end !== -1, `public/app.js: could not find the end of ${name}`);
    const source = lines.slice(start, end + 1).join("\n");
    assert.ok(source.includes(marker),
      `public/app.js: extracted ${source.length} chars for ${name} and it does not contain ${JSON.stringify(marker)} — the extractor is broken, not the app`);
    return source;
  }

  // The module-level binding must exist and must default to off. The probe substitutes its own
  // mutable copy below, so this is the check that it is substituting for something real.
  declaration("let networkEnabled = ", "NETWORK_ENABLED_DEFAULT");
  declaration("const NETWORK_ENABLED_DEFAULT = ", "false");

  // The statement inside refresh() that copies the server's answer onto the client's binding. It is
  // pulled in and EXECUTED rather than simulated with a test-only setter: a setter would keep every
  // assertion below green with this line deleted, which is the whole wire between the two halves.
  const applyLine = declaration("networkEnabled = Boolean(state.data", "networkEnabled");

  const sandboxState = { authMode: "operator", proMode: true, data: null };
  const sandbox = vm.createContext({ state: sandboxState, String, Object, Array, Boolean, Number });
  vm.runInContext(
    [
      "let networkEnabled = false;",
      declaration("const tabs = [", "timeline"),
      declaration("const simpleTabs = () =>", "settings"),
      declaration("const proTabs = () =>", "timeline"),
      topLevelFunction("isProMode", "proMode"),
      topLevelFunction("visibleTabs", "proTabs"),
      topLevelFunction("normalizeTab", "review"),
      "globalThis.probe = {",
      `  applyServerPayload: (payload) => { state.data = payload; ${applyLine} return networkEnabled; },`,
      "  visibleTabs: () => visibleTabs(),",
      "  normalizeTab: (tab) => normalizeTab(tab)",
      "};"
    ].join("\n\n"),
    sandbox,
    { filename: "public/app.js (tab gating)" }
  );

  const probe = sandbox.probe;

  // An older host that does not send the field at all must read as off, not undefined.
  assert.equal(probe.applyServerPayload({}), false,
    "a payload with no networkEnabled field must leave the client off");

  // --- flag off, driven by a real server payload ---
  assert.equal(probe.applyServerPayload({ networkEnabled: false }), false,
    "a payload saying networkEnabled false must leave the client off");
  const proTabsOff = probe.visibleTabs();
  assert.ok(!proTabsOff.includes("credits"),
    `with the network off, the Pro tab list must not offer credits, got ${JSON.stringify(proTabsOff)}`);
  assert.equal(probe.normalizeTab("credits"), "inbox",
    "with the network off, a ?tab=credits deep link must fall back to inbox rather than open a dead tab");
  sandboxState.proMode = false;
  assert.ok(!probe.visibleTabs().includes("credits"),
    `with the network off, the simple tab list must not offer credits, got ${JSON.stringify(probe.visibleTabs())}`);

  // --- flag on: the positive control for everything above ---
  assert.equal(probe.applyServerPayload({ networkEnabled: true }), true,
    "a payload saying networkEnabled true must turn the client on — this is the wire between the two halves");
  sandboxState.proMode = true;
  const proTabsOn = probe.visibleTabs();
  assert.ok(proTabsOn.includes("credits"),
    `with the network on, the Pro tab list must offer credits — without this, the assertions above would also pass against a tab list that never had a credits entry, got ${JSON.stringify(proTabsOn)}`);
  assert.equal(probe.normalizeTab("credits"), "credits",
    "with the network on, a ?tab=credits deep link must resolve to the credits tab");
  sandboxState.proMode = false;
  assert.ok(probe.visibleTabs().includes("credits"),
    `with the network on, the simple tab list must offer credits, got ${JSON.stringify(probe.visibleTabs())}`);

  // The non-credits tabs must survive both settings, so "the list changed" cannot be satisfied by a
  // tab list that collapsed to nothing.
  for (const tab of ["inbox", "tasks", "approvals", "context", "settings"]) {
    assert.ok(probe.visibleTabs().includes(tab), `the ordinary tab ${tab} must be present regardless of the network flag`);
  }

  console.log("Latch Network flag test passed: host env reaches both state payloads, and the client tab list follows it in both directions.");
} finally {
  await stopServer();
  await rm(dataDir, { recursive: true, force: true });
}
