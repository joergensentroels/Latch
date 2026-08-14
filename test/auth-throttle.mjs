// Failed-auth throttle (SECURITY-FINDINGS-2026-07.md F7).
//
// WHAT THIS ASSERTS, AND WHY IT IS WRITTEN THIS WAY: every check below is a BEHAVIOUR -- make N bad
// requests, assert the (N+1)th is refused -- and never the presence of a name. A previous pass in this
// repo shipped three checks whose negative controls stayed GREEN because they grepped for an identifier
// instead of exercising a code path; deleting the mechanism and leaving the word behind would have
// passed them. Nothing here would survive deleting the mechanism: the assertions are on status codes,
// on a header, on a webhook actually arriving, and on a log line the server actually wrote.
//
// The tunables are lowered through the environment so the suite runs in seconds. The MECHANISM is not
// changed by that -- grace, backoff and the trickle are the same code paths the defaults use.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = await mkdtemp(path.join(tmpdir(), "latch-auth-throttle-"));

const port = String(23000 + Math.floor(Math.random() * 1000));
const baseUrl = `http://127.0.0.1:${port}`;
// The two literals test/secret-scan.mjs allowlists by exact value. Inventing new op_/agent_ shaped
// fixtures here fails that scan -- correctly, since a scanner cannot tell a fixture from a real key.
const operatorToken = "op_test_operator";
const agentToken = "agent_test_agent";
const draftToken = "draft_test_token_throttle";
// Deliberately NOT op_ shaped, for the same reason.
const wrongToken = "wrong_key_never_valid";

// Grace 3 -> failures 1..3 are free, failure 4 crosses into throttled, request 5 is refused.
const grace = 3;
const backoffBaseMs = 1000;

// The operator's real notification path, stood up as a mock. The point of the burst alert is that it
// arrives WHERE APPROVALS ALREADY ARRIVE, so the test drives the same sendNotification/webhook path
// rather than a test-only hook.
const notifications = [];
const notifyPort = String(24000 + Math.floor(Math.random() * 1000));
const notifyServer = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    notifications.push(JSON.parse(raw));
  } catch {
    notifications.push({ unparsed: raw });
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise((resolve) => notifyServer.listen(Number(notifyPort), "127.0.0.1", resolve));

const child = spawn(process.execPath, ["server.js"], {
  cwd: root,
  env: {
    ...process.env,
    DATA_DIR: dataDir,
    HOST: "127.0.0.1",
    PORT: port,
    OPERATOR_TOKEN: operatorToken,
    AGENT_TOKEN: agentToken,
    DRAFT_TOKEN: draftToken,
    LATCH_AUTH_FAILURE_GRACE: String(grace),
    LATCH_AUTH_BACKOFF_BASE_MS: String(backoffBaseMs),
    LATCH_AUTH_BACKOFF_MAX_MS: "2000",
    LATCH_AUTH_FAILURE_WINDOW_MS: "600000",
    // Fires on the failure that crosses grace, so the test can assert BOTH silence below the
    // threshold and delivery at it, without sleeping through a backoff to get there.
    LATCH_AUTH_ALERT_THRESHOLD: "4",
    LATCH_AUTH_ALERT_COOLDOWN_MS: "60000",
    NOTIFY_ENABLED: "1",
    NOTIFY_PROVIDER: "webhook",
    NOTIFY_URL: `http://127.0.0.1:${notifyPort}/hook`,
    NOTIFY_TIMEOUT_MS: "2000",
    LATCH_SIMPLE_PLANNER_INTERVAL_MS: "0",
    // This suite deliberately generates failed-auth noise, and server.js tees stdout/stderr to the
    // REPO's latch.log by default -- so without this the test writes its own fixtures into the
    // operator's live log, where the secret scanner then finds them. Found the hard way.
    LATCH_LOG: "off"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

try {
  await waitForHealth();

  // ---- 1. The console gate: N bad keys, then refusal -------------------------------------------
  // The gap this closes: before F7 this loop could run forever at line rate.
  for (let attempt = 1; attempt <= grace; attempt++) {
    const response = await attempt_(`/api/state`, wrongToken);
    assert(response.status === 401, `console attempt ${attempt} should still be 401, got ${response.status}`);
  }
  assert(notifications.length === 0, `no burst alert should fire below the threshold, got ${notifications.length}`);

  const crossing = await attempt_("/api/state", wrongToken);
  assert(crossing.status === 401, `the grace-crossing attempt is still answered 401, got ${crossing.status}`);

  const refused = await attempt_("/api/state", wrongToken);
  assert(refused.status === 429, `attempt ${grace + 2} on the console gate must be refused with 429, got ${refused.status}`);
  assert(refused.body.error === "too_many_auth_failures", `429 body should name the reason, got ${JSON.stringify(refused.body)}`);
  const retryAfter = Number(refused.headers.get("retry-after"));
  assert(Number.isFinite(retryAfter) && retryAfter >= 1, `429 must carry a usable Retry-After, got ${refused.headers.get("retry-after")}`);

  // ---- 2. The property that makes it a throttle and not a decoration ----------------------------
  // A CORRECT key is refused while the source is throttled. If this were 200, the check would be
  // sitting behind the comparison, the attacker's guesses would all still be evaluated, and the whole
  // control would rate-limit only the answer -- not the attempt.
  const correctWhileThrottled = await attempt_("/api/state", operatorToken);
  assert(correctWhileThrottled.status === 429,
    `even the correct operator key must be refused while throttled (the check runs BEFORE the compare), got ${correctWhileThrottled.status}`);

  // ---- 3. The burst is observable ---------------------------------------------------------------
  const burst = await waitForNotification((item) => item.type === "auth.burst" && item.body?.includes("console"));
  assert(burst.title.includes("Latch"), `burst alert should be identifiable, got ${JSON.stringify(burst.title)}`);
  // Never ship the offered credential to a third-party notification provider: a near miss is most of
  // the key, and an operator typo is most of the REAL key.
  const burstText = JSON.stringify(burst);
  assert(!burstText.includes(wrongToken), "burst alert must not contain the offered credential");
  assert(!burstText.includes(operatorToken), "burst alert must not contain the real operator key");
  assert(/auth\.failure gate=console source=127\.0\.0\.1 failures=1 /.test(stderr),
    `the server must log each failed attempt; stderr had no matching auth.failure line:\n${stderr.slice(-1200)}`);
  assert(!stderr.includes(wrongToken) && !stderr.includes(operatorToken),
    "the log line must not contain any offered or real credential");

  // ---- 4. Recovery: the operator gets back in, and a success clears the count -------------------
  // This is the "do not lock the operator out of their own recovery" half. No admin action, no
  // restart, no waiting out a 15-minute lock: one backoff interval and the correct key works.
  await delay(backoffBaseMs + 250);
  const recovered = await attempt_("/api/state", operatorToken);
  assert(recovered.status === 200, `the correct key must work again after one backoff interval, got ${recovered.status}`);

  const afterSuccess = await attempt_("/api/state", wrongToken);
  assert(afterSuccess.status === 401,
    `a success must clear the counter, so the next miss is a fresh 401 rather than 429, got ${afterSuccess.status}`);

  // Start the next two sections from a KNOWN-CLEAN console bucket. Without this, a build where every
  // gate shares one bucket trips inside section 5 on leftover console failures, and section 6 -- the
  // check that actually names the defect -- never runs. Clearing here is what makes a section 6
  // failure mean "the buckets are shared" and nothing else.
  assert((await attempt_("/api/state", operatorToken)).status === 200, "operator should be able to clear its own bucket");

  // ---- 5. One credential, one bucket ------------------------------------------------------------
  // /api/draft and /api/assist accept the SAME token. If they had a bucket each, an attacker would
  // simply alternate and get double the guesses.
  const draftPaths = ["/api/draft", "/api/assist"];
  for (let attempt = 0; attempt <= grace; attempt++) {
    const target = draftPaths[attempt % 2];
    const response = await attempt_(target, "draft_wrong", "POST", { message: "hello" });
    assert(response.status === 401, `${target} attempt ${attempt + 1} should be 401, got ${response.status}`);
  }
  for (const target of draftPaths) {
    const response = await attempt_(target, "draft_wrong", "POST", { message: "hello" });
    assert(response.status === 429,
      `${target} must be refused once the shared draft-token bucket is throttled, got ${response.status}`);
  }

  // ---- 6. Gates are independent -----------------------------------------------------------------
  // The draft bucket is throttled right now. The console must not be: a throttle that spread across
  // credentials would let a worker with a bad draft token lock the operator out of the console.
  const consoleStillOpen = await attempt_("/api/state", wrongToken);
  assert(consoleStillOpen.status === 401,
    `a throttled draft gate must not refuse the console gate, got ${consoleStillOpen.status}`);
  const operatorStillWorks = await attempt_("/api/state", operatorToken);
  assert(operatorStillWorks.status === 200,
    `the operator must still be served while a different gate is throttled, got ${operatorStillWorks.status}`);

  // ---- 7. A request with no credential is not a guess -------------------------------------------
  // Counting these would let any unauthenticated passer-by -- or the operator's own browser before
  // the key is pasted in -- spend the operator's grace allowance.
  const workerPath = "/api/network/worker/heartbeat";
  for (let attempt = 1; attempt <= 10; attempt++) {
    const response = await attempt_(workerPath, "", "POST", {});
    assert(response.status === 401,
      `anonymous attempt ${attempt} must stay 401 and never accumulate, got ${response.status}`);
  }
  // POSITIVE CONTROL for the check above: prove this gate CAN throttle, so "10 anonymous requests were
  // never refused" means "no-credential requests are not counted" and not "this gate never throttles".
  for (let attempt = 0; attempt <= grace; attempt++) {
    const response = await attempt_(workerPath, "worker_wrong_token", "POST", {});
    assert(response.status === 401, `worker attempt ${attempt + 1} should be 401, got ${response.status}`);
  }
  const workerRefused = await attempt_(workerPath, "worker_wrong_token", "POST", {});
  assert(workerRefused.status === 429,
    `the worker gate must throttle a credentialled grinder, got ${workerRefused.status} (if this is 401 the anonymous check above proves nothing)`);

  // ---- 8. The operator can see it from the console ----------------------------------------------
  const about = await attempt_("/api/about", operatorToken);
  assert(about.status === 200, `/api/about should be readable by the operator, got ${about.status}`);
  const throttle = about.body.authThrottle;
  assert(throttle && typeof throttle === "object", "/api/about must report throttle state");
  assert(throttle.grace === grace, `/api/about should report the live grace setting, got ${throttle.grace}`);
  assert(throttle.throttledSources >= 1,
    `/api/about should show at least one currently throttled source, got ${throttle.throttledSources}`);
  assert(throttle.recent.some((item) => item.gate === "draft" && item.throttled),
    `/api/about should name the throttled gate, got ${JSON.stringify(throttle.recent)}`);
  assert(!JSON.stringify(throttle).includes("draft_wrong"),
    "throttle status must report counters and sources, never the credentials that were offered");

  console.log("Latch auth-throttle tests passed.");
} finally {
  child.kill();
  await onceExit(child);
  await new Promise((resolve) => notifyServer.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
}

async function attempt_(pathname, token, method = "GET", body = null) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, headers: response.headers, body: parsed };
}

async function waitForNotification(match) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const found = notifications.find(match);
    if (found) return found;
    await delay(50);
  }
  throw new Error(`no matching notification was delivered within 5s; received ${JSON.stringify(notifications)}`);
}

async function waitForHealth() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await delay(100);
  }
  throw new Error(`server did not become healthy\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function onceExit(process) {
  if (process.exitCode !== null || process.signalCode) return Promise.resolve();
  return new Promise((resolve) => process.once("exit", resolve));
}
