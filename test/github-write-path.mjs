// The GitHub connector: the WRITE path (issue, issue comment, pull request) and the read routes the
// Settings -> GitHub connector panel drives (doctor, branches, delete-branch).
//
// This subsystem holds the GitHub token and, on an operator's approval, creates branches, commits files
// and opens pull requests on their behalf. Until this file existed, `github_issue`, `github_issue_comment`
// and `github_pull_request` had ZERO hits anywhere in test/ — the only GitHub coverage was
// github-prune.mjs, which tests branch CLASSIFICATION, a pure function that never touches an approval.
//
// Nothing here calls github.com. The connector's base URL is an env var (GITHUB_API_URL), so a mock HTTP
// server stands in for the API and RECORDS every request it is handed. Every assertion below is therefore
// about the bytes that reached the API, not about what server.js says it sends.
//
// TWO VACUITY TRAPS THIS FILE DELIBERATELY DISARMS:
//
// 1. "The approval came back pending" proves nothing on its own. Under `full_access` these three types
//    would come back pending even with the hard boundary DELETED, because the full_access branch has no
//    rule that matches them either — the assertion would stay green against the mutation it exists to
//    catch. So the boundary section carries a POSITIVE CONTROL: a github_file approval to the exempted
//    own repo, which auto-approves in the same run under the same policy. If that one is not approved,
//    "pending" means the harness never reached full_access, and the whole section is void.
//
// 2. "No GitHub request was recorded" proves nothing unless the recorder is known to record. Every
//    lookup goes through `oneCall`, which fails loudly when it finds zero matches, and the denial
//    section asserts silence only after the identical payload has been shown to produce traffic.

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = await mkdtemp(path.join(tmpdir(), "latch-gh-write-"));

const port = String(28000 + Math.floor(Math.random() * 1000));
const githubPort = String(29000 + Math.floor(Math.random() * 1000));
const baseUrl = `http://127.0.0.1:${port}`;
// The two literals test/secret-scan.mjs allowlists by exact value; inventing new op_/agent_ shaped
// fixtures here fails that scan, correctly, since a scanner cannot tell a fixture from a real key.
const operatorToken = "op_test_operator";
const agentToken = "agent_test_agent";
const operatorHeaders = { authorization: `Bearer ${operatorToken}` };
const agentHeaders = { authorization: `Bearer ${agentToken}` };

// Invented. Nothing in this file is a real credential, repository, owner or issue number.
const githubToken = "gh_fixture_write_path";
const owner = "fixture-owner";
const repo = "fixture-connector";
const ownRepo = "CompassProjects";     // the one repo github_file is exempted for, host-side
const lockedRepo = "fixture-locked";   // the mock answers 403 here, to exercise the failure contract
const repoDefaultBranch = "mainline";  // deliberately NOT the base the PR approval asks for
const prBase = "trunk";
const baseSha = "1111111111111111111111111111111111111111";
const reviewBranch = "fixture/under-review";   // an OPEN pull request points at this one
const abandonedBranch = "fixture/abandoned";   // closed without merging, so prunable

// ---------------------------------------------------------------------------------------------
// The mock GitHub API. Records everything; answers only what the connector actually calls.
// ---------------------------------------------------------------------------------------------

const calls = [];
let badAuth = 0;

const mockGithub = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  // The connector must present the configured token on every call. Counted rather than thrown, so a
  // regression surfaces as an assertion at the end instead of as a confusing timeout mid-run.
  if (req.headers.authorization !== `Bearer ${githubToken}`) badAuth += 1;
  const url = new URL(req.url, "http://mock.invalid");
  const p = url.pathname;
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = { unparsed: raw }; }
  calls.push({ method: req.method, path: p, search: url.search, body });

  const json = (status, payload) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  const notFound = () => json(404, { message: "Not Found" });

  if (p === "/user" && req.method === "GET") return json(200, { login: owner });

  const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(p);
  if (!repoMatch) return notFound();
  const [, callOwner, callRepo, rest = ""] = repoMatch;
  if (callOwner !== owner) return notFound();

  // Everything under the locked repo 403s, so the "a failed write must not mark the action done"
  // contract can be exercised without any special-casing inside server.js.
  if (callRepo === lockedRepo) return json(403, { message: "Resource not accessible by personal access token" });

  if (![repo, ownRepo].includes(callRepo)) return notFound();

  if (rest === "" && req.method === "GET") {
    return json(200, {
      name: callRepo,
      full_name: `${callOwner}/${callRepo}`,
      default_branch: repoDefaultBranch,
      delete_branch_on_merge: false,
      permissions: { admin: true, push: true }
    });
  }

  // Refs. The PR base exists; the head branch does not, until the connector creates it.
  const refMatch = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
  if (refMatch && req.method === "GET") {
    const ref = decodeURIComponent(refMatch[1]);
    if ([prBase, repoDefaultBranch, abandonedBranch, reviewBranch].includes(ref)) return json(200, { ref: `refs/heads/${ref}`, object: { sha: baseSha } });
    return notFound();
  }
  if (rest === "/git/refs" && req.method === "POST") {
    return json(201, { ref: body?.ref, object: { sha: baseSha } });
  }
  if (/^\/git\/refs\/heads\/.+$/.test(rest) && req.method === "DELETE") return json(204, {});

  // The panel's read routes. One branch of each kind the classifier distinguishes, so the listing the
  // panel renders is not all one shape.
  if (rest === "/branches" && req.method === "GET") {
    return json(200, [
      { name: repoDefaultBranch, protected: false, commit: { sha: baseSha } },
      { name: "release-guard", protected: true, commit: { sha: baseSha } },
      { name: reviewBranch, protected: false, commit: { sha: baseSha } },
      { name: abandonedBranch, protected: false, commit: { sha: baseSha } },
      { name: "wip-no-pr-yet", protected: false, commit: { sha: baseSha } }
    ]);
  }
  if (rest === "/pulls" && req.method === "GET") {
    if (url.searchParams.get("state") === "closed") {
      return json(200, [{ number: 51, head: { ref: abandonedBranch }, merged_at: null }]);
    }
    // The open-PR list is also how delete-branch decides to refuse; `head` narrows it to one branch there.
    const head = url.searchParams.get("head") || "";
    const open = [{ number: 60, head: { ref: reviewBranch } }];
    return json(200, head ? open.filter((p) => head.endsWith(`:${p.head.ref}`)) : open);
  }
  if (rest === "/issues" && req.method === "GET") return json(200, []);

  if (rest.startsWith("/contents/")) {
    const filePath = decodeURIComponent(rest.slice("/contents/".length));
    if (req.method === "GET") return notFound();   // every fixture file is new
    if (req.method === "PUT") {
      return json(200, {
        content: { path: filePath, sha: `blob_${calls.length}`, html_url: `https://github.invalid/${callOwner}/${callRepo}/blob/x/${filePath}` },
        commit: { sha: `commit_${calls.length}` }
      });
    }
  }

  if (rest === "/pulls" && req.method === "POST") {
    return json(201, { number: 77, html_url: `https://github.invalid/${callOwner}/${callRepo}/pull/77` });
  }

  if (rest === "/issues" && req.method === "POST") {
    return json(201, { number: 31, html_url: `https://github.invalid/${callOwner}/${callRepo}/issues/31` });
  }

  const issueMatch = /^\/issues\/(\d+)$/.exec(rest);
  if (issueMatch && req.method === "GET") {
    return json(200, { number: Number(issueMatch[1]), state: "open", html_url: `https://github.invalid/${callOwner}/${callRepo}/issues/${issueMatch[1]}` });
  }
  const commentMatch = /^\/issues\/(\d+)\/comments$/.exec(rest);
  if (commentMatch && req.method === "POST") {
    return json(201, { id: 909, html_url: `https://github.invalid/${callOwner}/${callRepo}/issues/${commentMatch[1]}#issuecomment-909` });
  }

  return notFound();
});
await new Promise((resolve) => mockGithub.listen(Number(githubPort), "127.0.0.1", resolve));

// ---------------------------------------------------------------------------------------------
// The real server, on a temp DATA_DIR.
// ---------------------------------------------------------------------------------------------

const child = spawn(process.execPath, ["server.js"], {
  cwd: root,
  env: {
    ...process.env,
    DATA_DIR: dataDir,
    HOST: "127.0.0.1",
    PORT: port,
    OPERATOR_TOKEN: operatorToken,
    AGENT_TOKEN: agentToken,
    GITHUB_TOKEN: githubToken,
    GITHUB_API_URL: `http://127.0.0.1:${githubPort}`,
    GITHUB_OWNER: owner,
    GITHUB_DEFAULT_REPO: repo,
    GITHUB_TIMEOUT_MS: "4000",
    LATCH_SIMPLE_PLANNER_INTERVAL_MS: "0",
    // server.js tees stdout/stderr into the REPO's latch.log by default, where the secret scanner would
    // then find this file's invented token. Same trap auth-throttle.mjs documents.
    LATCH_LOG: "off"
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let stderr = "";
child.stdout.on("data", () => {});
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function waitForHealth() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const json = await request("/api/health");
      if (json.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`server did not become healthy\nstderr:\n${stderr}`);
}

const fileApproval = (payload) => request("/api/approvals", { method: "POST", headers: agentHeaders, body: payload });
const decide = (id, body) => request(`/api/approvals/${id}`, { method: "PATCH", headers: operatorHeaders, body });

// Every extractor in this file goes through here, so "the connector did not send that" can never be
// mistaken for "the recorder was not looking". Zero matches is a failure, never a pass.
function oneCall(from, method, predicate, label) {
  const found = calls.slice(from).filter((c) => c.method === method && predicate(c.path, c));
  assert.ok(found.length > 0, `no ${method} call recorded for ${label} — the connector never reached the API (recorded ${calls.length - from} call(s) in this window)`);
  assert.equal(found.length, 1, `expected exactly one ${method} call for ${label}, got ${found.length}`);
  return found[0];
}

try {
  await waitForHealth();

  // ===========================================================================================
  // 1. The hard boundary: these three types always require a human.
  // ===========================================================================================
  const policy = await request("/api/autonomy", { method: "PATCH", headers: operatorHeaders, body: { mode: "full_access" } });
  assert.equal(policy.mode, "full_access", "the harness must actually be in the most permissive mode");

  // THE POSITIVE CONTROL for this whole section. github_file to the own repo is the one GitHub write the
  // host exempts from the boundary, so under full_access it must auto-approve — proving the policy is
  // live, the auto path works in this run, and "pending" below is a refusal rather than an inert harness.
  const exempt = await fileApproval({
    type: "github_file",
    title: "Fixture: own-repo file commit",
    githubRepoName: ownRepo,
    githubFilePath: "notes/fixture.md",
    githubFileContent: "own-repo fixture content\n",
    githubCommitMessage: "Fixture own-repo commit"
  });
  assert.equal(exempt.status, "approved",
    `the exempted own-repo file commit must auto-approve under full_access — without this, "pending" below proves nothing (got ${exempt.status}: ${exempt.decisionReason})`);
  assert.equal(exempt.decisionMode, "auto", "and it must be the autonomy policy that approved it");

  const boundaryFixtures = {
    github_issue: {
      type: "github_issue",
      title: "Fixture: please file an issue",
      githubRepoName: repo,
      githubIssueTitle: "Boundary fixture issue",
      githubIssueBody: "Boundary fixture body."
    },
    github_issue_comment: {
      type: "github_issue_comment",
      title: "Fixture: please comment",
      githubRepoName: repo,
      githubIssueNumber: 4242,
      githubIssueBody: "Boundary fixture comment."
    },
    github_pull_request: {
      type: "github_pull_request",
      title: "Fixture: please open a PR",
      githubRepoName: repo,
      githubPrTitle: "Boundary fixture PR",
      githubPrFiles: [{ path: "boundary.txt", content: "boundary fixture file\n" }]
    }
  };

  const beforeBoundary = calls.length;
  const boundaryApprovals = {};
  for (const [type, payload] of Object.entries(boundaryFixtures)) {
    const created = await fileApproval(payload);
    boundaryApprovals[type] = created;
    assert.equal(created.type, type, `${type} must be an accepted approval type`);
    assert.equal(created.status, "pending", `${type} must stay pending even under full access`);
    assert.equal(created.decisionMode, "human", `${type} must be marked as needing a human`);
    // Which mechanism refused matters: the full_access fallthrough also says "human", so the reason is
    // what distinguishes "the boundary held" from "no rule happened to match".
    assert.match(created.decisionReason, /Human boundary/,
      `${type} must be refused by the hard boundary, not by the absence of a matching auto rule (got: ${created.decisionReason})`);
  }
  assert.equal(calls.length, beforeBoundary, "filing an approval must not touch the GitHub API at all — nothing is written before a decision");

  // Not grantable either: "allow this always" must not create a standing permission for a type the
  // boundary owns. Floored by a positive control immediately below, so "no grant appeared" is a fact
  // about these types and not about the grant machinery being inert in this harness.
  //
  // Back to default_permissions first, and the floor is why: a grant is recorded only on the transition
  // INTO approved, and under full_access bounded research auto-approves at filing — leaving no operator
  // decision for the grant to attach to. The control caught exactly that, which is the point of having it.
  await request("/api/autonomy", { method: "PATCH", headers: operatorHeaders, body: { mode: "default_permissions" } });
  const research = await fileApproval({
    type: "web_research",
    title: "Fixture: bounded research",
    seedUrls: ["https://example.test/fixture"],
    allowedDomains: ["example.test"],
    maxPages: 2,
    tokenBudget: 1000
  });
  await decide(research.id, { status: "approved", grant: "always" });
  const withResearchGrant = (await request("/api/state", { headers: operatorHeaders })).grants || [];
  assert.ok(withResearchGrant.some((g) => g.key === "research"),
    `the grant machinery must be working in this harness before absence of a grant can mean anything (got ${JSON.stringify(withResearchGrant.map((g) => g.key))})`);

  await decide(boundaryApprovals.github_issue.id, { status: "approved", grant: "always" });
  const afterIssueGrant = (await request("/api/state", { headers: operatorHeaders })).grants || [];
  assert.equal(afterIssueGrant.length, withResearchGrant.length,
    `approving a github_issue with "always" must record no grant (grants went ${withResearchGrant.length} -> ${afterIssueGrant.length}: ${JSON.stringify(afterIssueGrant.map((g) => g.key))})`);
  assert.ok(!afterIssueGrant.some((g) => /github_issue|github_pull/.test(g.key)),
    "no standing permission may exist for issue/comment/PR posting");

  // ===========================================================================================
  // 2. A denial executes nothing.
  // ===========================================================================================
  const toDeny = await fileApproval({
    type: "github_pull_request",
    title: "Fixture: PR that will be denied",
    githubRepoName: repo,
    githubPrTitle: "Denied fixture PR",
    githubPrBody: "This must never be opened.",
    githubPrBase: prBase,
    githubPrBranch: "bureau/denied-fixture",
    githubPrFiles: [{ path: "denied.txt", content: "must never be committed\n" }]
  });
  const beforeDenial = calls.length;
  const denied = await decide(toDeny.id, { status: "denied", note: "Not this one." });
  assert.equal(denied.status, "denied", "the denial must be recorded");
  assert.equal(calls.length - beforeDenial, 0,
    `a denied pull request must reach the GitHub API zero times, saw ${calls.length - beforeDenial}: ${JSON.stringify(calls.slice(beforeDenial).map((c) => `${c.method} ${c.path}`))}`);
  assert.equal(denied.githubPrNumber, 0, "a denied approval carries no pull request number");
  assert.equal(denied.githubPrUrl, "", "a denied approval carries no pull request URL");

  // ===========================================================================================
  // 3. What the operator approved is what the host sent.
  //
  // Each fixture sets the worker's free-text `title` DIFFERENT from the typed field the executor uses,
  // so an assertion can only pass if the host read the typed field. That is SECURITY-FINDINGS F1 applied
  // to the write path: the prose the operator reads and the payload the host runs must be the same thing.
  // ===========================================================================================

  // ---- github_issue ----
  const issueFixture = {
    type: "github_issue",
    title: "Worker prose that must not become the issue title",
    details: "Worker prose that must not become the issue body.",
    githubRepoName: repo,
    githubIssueTitle: "Doctor endpoint has no operator-visible UI",
    githubIssueBody: "Nine connector endpoints are drivable only by curl.\n\nFiled by a fixture.",
    githubIssueLabels: ["fixture-label", "connector"]
  };
  const issue = await fileApproval(issueFixture);
  const beforeIssue = calls.length;
  const approvedIssue = await decide(issue.id, { status: "approved" });
  assert.equal(approvedIssue.status, "approved", `the issue approval must succeed (${approvedIssue.responseNote})`);

  const issuePost = oneCall(beforeIssue, "POST", (p) => p === `/repos/${owner}/${repo}/issues`, "github_issue");
  assert.equal(issuePost.body.title, issueFixture.githubIssueTitle, "the issue title sent is the approved githubIssueTitle, not the worker's prose title");
  assert.notEqual(issuePost.body.title, issueFixture.title, "and it is demonstrably not the prose title");
  assert.equal(issuePost.body.body, issueFixture.githubIssueBody, "the issue body sent is the approved githubIssueBody");
  assert.deepEqual(issuePost.body.labels, issueFixture.githubIssueLabels, "the labels sent are the approved labels");
  assert.equal(approvedIssue.githubIssueNumber, 31, "the created issue number is stored back on the approval");
  assert.ok(approvedIssue.githubIssueUrl.includes("/issues/31"), "and so is its URL, so the operator can follow it");

  // ---- github_issue_comment ----
  const commentFixture = {
    type: "github_issue_comment",
    title: "Worker prose that must not become the comment",
    details: "Worker prose that must not become the comment either.",
    githubRepoName: repo,
    githubIssueNumber: 4242,
    githubIssueBody: "Fixture comment text, posted host-side on the operator's approval."
  };
  const comment = await fileApproval(commentFixture);
  const beforeComment = calls.length;
  const approvedComment = await decide(comment.id, { status: "approved" });
  assert.equal(approvedComment.status, "approved", `the comment approval must succeed (${approvedComment.responseNote})`);

  // The existence check first: a wrong number must fail as "no such issue", not as a bare 404 that reads
  // like a permissions problem.
  oneCall(beforeComment, "GET", (p) => p === `/repos/${owner}/${repo}/issues/4242`, "the pre-comment issue lookup");
  const commentPost = oneCall(beforeComment, "POST", (p) => p === `/repos/${owner}/${repo}/issues/4242/comments`, "github_issue_comment");
  assert.equal(commentPost.body.body, commentFixture.githubIssueBody, "the comment text sent is the approved githubIssueBody");
  assert.notEqual(commentPost.body.body, commentFixture.details, "and it is demonstrably not the worker's prose");
  assert.ok(approvedComment.githubIssueUrl.includes("issuecomment-909"), "the posted comment's URL is stored back on the approval");

  // ---- github_pull_request ----
  const prFixture = {
    type: "github_pull_request",
    title: "Worker prose that must not become the PR title",
    details: "Worker prose that must not become the PR body.",
    githubRepoName: repo,
    githubPrTitle: "Add a connector panel and its tests",
    githubPrBody: "Fixture pull request body.",
    githubPrBase: prBase,
    githubPrBranch: "bureau/fixture-connector-panel",
    githubCommitMessage: "Fixture commit message",
    githubPrFiles: [
      { path: "docs/alpha.md", content: "alpha fixture content" },
      { path: "docs/beta.md", content: "beta fixture content" }
    ]
  };
  const pr = await fileApproval(prFixture);
  // The comparison below is against the STORED approval, because that record is what the operator's card
  // renders and what the executor reads. Cross-checked against the submitted fixture here so that a
  // server-side rewrite of the payload could not make both sides agree on something nobody asked for.
  assert.equal(pr.githubPrFiles.length, 2, "both fixture files survive into the stored approval");
  assert.deepEqual(pr.githubPrFiles, prFixture.githubPrFiles, "and they are stored exactly as submitted");
  const beforePr = calls.length;
  const approvedPr = await decide(pr.id, { status: "approved" });
  assert.equal(approvedPr.status, "approved", `the pull request approval must succeed (${approvedPr.responseNote})`);

  const head = prFixture.githubPrBranch;
  const refPost = oneCall(beforePr, "POST", (p) => p === `/repos/${owner}/${repo}/git/refs`, "the branch creation");
  assert.equal(refPost.body.ref, `refs/heads/${head}`, "the branch created is the one named on the approval");
  assert.equal(refPost.body.sha, baseSha, "and it is cut from the tip of the approved base branch");

  const puts = calls.slice(beforePr).filter((c) => c.method === "PUT" && c.path.startsWith(`/repos/${owner}/${repo}/contents/`));
  assert.equal(puts.length, 2, `both approved files must be committed, saw ${puts.length}`);
  for (const file of pr.githubPrFiles) {
    assert.ok(file.content.includes("fixture content"), `the stored content for ${file.path} is empty or unrecognisable — the comparison below would be vacuous`);
    const put = puts.find((c) => c.path === `/repos/${owner}/${repo}/contents/${file.path.split("/").map(encodeURIComponent).join("/")}`);
    assert.ok(put, `no commit recorded for the approved file ${file.path}`);
    assert.equal(Buffer.from(put.body.content, "base64").toString("utf8"), file.content,
      `${file.path} must be committed with exactly the content the operator approved`);
    assert.equal(put.body.branch, head, `${file.path} must land on the new branch, never on the base`);
    assert.equal(put.body.message, prFixture.githubCommitMessage, `${file.path} must carry the approved commit message`);
  }

  const prPost = oneCall(beforePr, "POST", (p) => p === `/repos/${owner}/${repo}/pulls`, "github_pull_request");
  assert.equal(prPost.body.title, prFixture.githubPrTitle, "the PR title sent is the approved githubPrTitle, not the worker's prose title");
  assert.notEqual(prPost.body.title, prFixture.title, "and it is demonstrably not the prose title");
  assert.equal(prPost.body.body, prFixture.githubPrBody, "the PR body sent is the approved githubPrBody");
  assert.equal(prPost.body.head, head, "the PR is opened from the approved branch");
  assert.equal(prPost.body.base, prBase, "and against the approved base");
  assert.notEqual(prPost.body.base, repoDefaultBranch,
    "the base must come from the approval, not from the repository default (the fixture makes these differ on purpose)");
  assert.equal(approvedPr.githubPrNumber, 77, "the opened PR number is stored back on the approval");
  assert.ok(approvedPr.githubPrUrl.includes("/pull/77"), "and so is its URL");
  assert.equal(approvedPr.githubPrBranch, head, "the branch actually used is recorded on the approval");
  assert.equal(approvedPr.githubPrBase, prBase, "as is the base actually used");

  // ===========================================================================================
  // 4. A failed write must not mark the action done.
  //
  // The documented contract: on failure the approval goes BACK to pending with the reason, so the
  // operator can retry a transient GitHub error instead of the action being silently recorded as done.
  // ===========================================================================================
  const doomed = await fileApproval({
    type: "github_issue",
    title: "Fixture: issue against a repo the token cannot write",
    githubRepoName: lockedRepo,
    githubIssueTitle: "Should never be created",
    githubIssueBody: "The mock answers 403 for this repository."
  });
  const beforeDoomed = calls.length;
  const failed = await decide(doomed.id, { status: "approved" });
  assert.ok(calls.length > beforeDoomed, "the connector must actually have attempted the write — otherwise this proves nothing about failure handling");
  assert.equal(failed.status, "pending", `a failed GitHub write must return the approval to pending, got ${failed.status}`);
  assert.match(failed.responseNote, /failed/i, "and the operator must be told it failed");
  assert.match(failed.responseNote, /403/, "including the status GitHub returned, so the cause is diagnosable");
  assert.equal(failed.githubIssueUrl, "", "a failed issue creation must not leave a URL behind");
  assert.equal(failed.githubIssueNumber, 0, "nor a number");

  // ===========================================================================================
  // 5. The panel's read routes, checked by RENDERING them.
  //
  // The Settings -> GitHub connector panel drives /doctor, /branches and /delete-branch. Asserting the
  // endpoints "return the right fields" by name would not catch the failure that actually happens here:
  // the panel reading a field the endpoint does not have (`.deliverables` from something that returns
  // `.files`), which renders as nothing at all and passes every name-based check on the server side.
  //
  // So this pulls the panel's own render functions out of public/app.js and RUNS them on the real
  // responses, then asserts the distinctive values are present in the HTML they produce. A field-name
  // drift on either side removes those values from the output, and this goes red.
  // ===========================================================================================
  const appSource = await readFile(path.join(root, "public", "app.js"), "utf8");

  // Top-level functions in this file all close on a line that is exactly "}". Floored below, so a
  // formatting change fails loudly instead of extracting nothing and making the checks vacuous.
  function topLevelFunction(name, marker) {
    const lines = appSource.split("\n");
    const start = lines.findIndex((line) => line.startsWith(`function ${name}(`));
    assert.ok(start !== -1, `public/app.js: function ${name} not found — the panel it belongs to is gone or renamed`);
    const end = lines.findIndex((line, index) => index > start && line === "}");
    assert.ok(end !== -1, `public/app.js: could not find the end of ${name}`);
    const source = lines.slice(start, end + 1).join("\n");
    // Each extraction must contain something only that function has. An extractor that silently returns
    // a fragment would make every render assertion below vacuous, which is the failure this guards.
    assert.ok(source.includes(marker),
      `public/app.js: extracted ${source.length} chars for ${name} and it does not contain ${JSON.stringify(marker)} — the extractor is broken, not the panel`);
    return source;
  }

  const doctorGrid = { innerHTML: "" };
  const branchList = { innerHTML: "" };
  const sandbox = vm.createContext({ githubDoctorGrid: doctorGrid, githubBranchList: branchList, String, Object, Array, Boolean, Number });
  vm.runInContext(
    [
      topLevelFunction("escapeHtml", "&amp;"),
      topLevelFunction("renderGithubDoctor", "status-card"),
      topLevelFunction("renderGithubBranches", "data-github-delete-branch")
    ].join("\n\n"),
    sandbox,
    { filename: "public/app.js (github panel)" }
  );

  // ---- doctor ----
  const report = await request(`/api/github/doctor?owner=${owner}&repo=${repo}`, { headers: operatorHeaders });
  assert.ok(report.checks?.length >= 3, `the doctor must probe several capabilities, got ${JSON.stringify(report.checks)}`);
  assert.equal(report.allOk, true, `every capability must be reachable against the mock, got hint: ${report.hint}`);
  assert.ok(report.unprovable?.length >= 1, "the doctor must still report what no read can verify");
  assert.ok(!JSON.stringify(report).includes(githubToken), "the doctor must never echo the token");

  vm.runInContext(`renderGithubDoctor(${JSON.stringify(report)})`, sandbox);
  assert.ok(doctorGrid.innerHTML.length > 0, "the doctor panel rendered nothing at all");
  for (const check of report.checks) {
    assert.ok(doctorGrid.innerHTML.includes(check.capability),
      `the doctor panel does not show the "${check.capability}" capability the endpoint reported`);
  }
  assert.ok(doctorGrid.innerHTML.includes("Administration"),
    "the panel must surface the unprovable Administration note — a green verdict must not imply a check that never ran");

  // ---- branches ----
  const listing = await request(`/api/github/branches?owner=${owner}&repo=${repo}`, { headers: operatorHeaders });
  assert.equal(listing.count, 5, `the branch listing must come back complete, got ${listing.count}`);
  assert.equal(listing.prunableCount, 1, `exactly the abandoned fixture branch is prunable, got ${listing.prunableCount}`);
  assert.equal(listing.branches.find((b) => b.name === reviewBranch)?.openPr, 60, "the branch under review reports its open pull request");
  assert.equal(listing.branches.find((b) => b.name === abandonedBranch)?.prunable, true, "the abandoned branch is the prunable one");
  assert.equal(listing.branches.find((b) => b.name === repoDefaultBranch)?.isDefault, true, "the default branch is flagged as default");

  vm.runInContext(`renderGithubBranches(${JSON.stringify(listing)})`, sandbox);
  for (const branch of listing.branches) {
    assert.ok(branchList.innerHTML.includes(branch.name), `the branch panel does not show ${branch.name}`);
  }
  assert.ok(branchList.innerHTML.includes("PR #60 open"), "the panel must show that an open pull request points at a branch");
  assert.ok(branchList.innerHTML.includes(`data-github-delete-branch="${abandonedBranch}"`),
    "the prunable branch must offer a delete button");
  assert.ok(!branchList.innerHTML.includes(`data-github-delete-branch="${reviewBranch}"`),
    "a branch with an open pull request must NOT offer a delete button");
  assert.ok(!branchList.innerHTML.includes(`data-github-delete-branch="${repoDefaultBranch}"`),
    "the default branch must NOT offer a delete button");

  // ---- delete-branch: the host's own two refusals, which the panel is only a second lock on ----
  const beforeDelete = calls.length;
  const refusedDefault = await request("/api/github/delete-branch", { method: "POST", headers: operatorHeaders, body: { owner, repo, branch: repoDefaultBranch } });
  assert.match(refusedDefault.error, /default branch/, `deleting the default branch must be refused, got ${JSON.stringify(refusedDefault)}`);
  const refusedOpen = await request("/api/github/delete-branch", { method: "POST", headers: operatorHeaders, body: { owner, repo, branch: reviewBranch } });
  assert.match(refusedOpen.error, /still open/, `deleting a branch under review must be refused, got ${JSON.stringify(refusedOpen)}`);
  assert.equal(calls.slice(beforeDelete).filter((c) => c.method === "DELETE").length, 0,
    "neither refusal may have reached the DELETE — the guard must run before the call, not after");

  const deleted = await request("/api/github/delete-branch", { method: "POST", headers: operatorHeaders, body: { owner, repo, branch: abandonedBranch } });
  assert.equal(deleted.ok, true, `the abandoned branch must actually delete, got ${JSON.stringify(deleted)}`);
  oneCall(beforeDelete, "DELETE", (p) => p === `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(abandonedBranch)}`, "the branch deletion");

  // ===========================================================================================
  // Floors: the recorder recorded, and the token travelled on every call.
  // ===========================================================================================
  assert.ok(calls.length >= 12, `only ${calls.length} GitHub calls recorded across the whole run — the mock is not being reached`);
  assert.equal(badAuth, 0, `${badAuth} GitHub call(s) arrived without the configured token`);

  console.log(`GitHub connector test passed: issue, comment and pull request executed from approvals, `
    + `doctor/branches/delete-branch rendered through the panel's own functions, ${calls.length} API calls recorded and checked.`);
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => { child.on("exit", resolve); setTimeout(resolve, 3000); });
  await new Promise((resolve) => mockGithub.close(resolve));
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}
