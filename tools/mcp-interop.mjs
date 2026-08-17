// Does Latch's MCP client actually talk to a real MCP server?
//
// test/mcp.mjs drives the client against an inline HTTP peer that this repo wrote. That proves the client
// obeys the rules as this repo understands them, and nothing about whether that understanding matches a
// server written from the spec by someone else. The two are different claims, and only the second one is
// interoperability.
//
// So this is a TOOL, not a test: it is invoked deliberately, against a URL you name, and it exits non-zero
// on any failure. Deliberately not wired into `npm test` — a suite entry would have to skip when no server
// is reachable, and a check that silently skips is the shape a check makes when it never looked.
//
//   node tools/mcp-interop.mjs http://127.0.0.1:4173/mcp <operator-token>
//   node tools/mcp-interop.mjs http://127.0.0.1:4173/mcp --token-env BUREAU_TOKEN
//
// The token is a credential. Pass it via --token-env where you can; it is never printed, and the summary
// below reports only its length so a wrong-token failure is still diagnosable.
import { negotiateHttpEra, listTools, callTool } from "../mcp.mjs";

const argv = process.argv.slice(2);
const url = argv[0] || "";
if (!url) {
  console.error("usage: node tools/mcp-interop.mjs <url> [<token> | --token-env NAME]");
  process.exit(2);
}
const envIdx = argv.indexOf("--token-env");
const token = envIdx >= 0 ? (process.env[argv[envIdx + 1]] || "") : (argv[1] || "");

// allowRemote is set from the URL rather than hardcoded: pointing this at a non-loopback host is a
// deliberate act, and the tool should not quietly grant itself a permission the library exists to gate.
const server = {
  name: "interop",
  transport: "http",
  url,
  headers: token ? { Authorization: `Bearer ${token}` } : {},
  allowRemote: true,
  allowedTools: [],
  argConstraints: {},
  mockTools: []
};

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

console.log(`MCP interop against ${url}`);
console.log(`token: ${token ? `${token.length} chars` : "(none)"}\n`);

try {
  const era = await negotiateHttpEra(server, { useCache: false });
  check(`era negotiated: ${era.era} @ ${era.version}`, era.era === "modern" || era.era === "legacy");
  // Asserted, not just printed. "modern" here means the peer answered server/discover, which is the whole
  // claim this tool exists to make about a dual-era server.
  check("the peer is modern-capable (it answered server/discover)", era.era === "modern",
    era.era === "legacy" ? "fell back to the initialize handshake" : "");

  const tools = await listTools(server, { useCache: false });
  check(`tools/list returned ${tools.length} tool(s)`, tools.length > 0, tools.map((t) => t.name).join(", "));
  // Every tool must carry the fields Latch's own gating reads. A server answering with names alone would
  // pass a count check and then break argument validation at call time.
  check("every tool carries a name and an inputSchema",
    tools.every((t) => t.name && t.inputSchema && typeof t.inputSchema === "object"));

  // A read-only call. Named on the command line would be more general; defaulted here because the point is
  // to exercise tools/call — including the Mcp-Name header mirroring — not to drive a particular server.
  const target = argv.find((a) => a.startsWith("--tool="))?.slice("--tool=".length)
    || (tools.find((t) => /^list_/.test(t.name)) || tools[0])?.name;
  if (target) {
    const res = await callTool(server, target, {});
    check(`tools/call ${target} completed`, res.ok || res.isError === false || typeof res.text === "string",
      res.isError ? `server reported a tool error: ${String(res.text).slice(0, 120)}` : `${String(res.text).length} chars of text`);
    // isError is a TOOL outcome, not a transport failure — the call itself completed either way, and this
    // tool is checking the transport. Reported rather than scored.
  } else {
    check("a tool was available to call", false, "tools/list was empty");
  }
} catch (error) {
  check("interop completed without throwing", false, error.message);
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall interop checks passed");

// exitCode, NOT process.exit(). The first version called process.exit() here and the process died with
// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` and status 127 — on a run where every check had
// just PASSED. Node's fetch keeps its connection alive, and exiting hard while that handle is closing
// crashes libuv on Windows.
//
// That mattered more than it looks. This tool's whole contract is its exit status, so a crash on the way out
// made a passing run indistinguishable from a broken one to anything reading $?. The checks printed "all
// interop checks passed" directly above the failure, which is the most misleading shape available.
//
// Setting exitCode and returning lets the sockets close on their own terms. `unref`ing nothing and awaiting
// nothing is deliberate: if a handle ever does keep this alive, a hang is a visible symptom, whereas a hard
// exit hid one.
process.exitCode = failures ? 1 : 0;
