import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirs = new Set([".git", "data", "node_modules", "__pycache__"]);
const binaryExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".ico"]);

const patterns = [
  {
    name: "local Tailscale IP",
    regex: /\b100\.(98\.130\.94|67\.106\.85)\b/g
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
  {
    name: "temporary setup password",
    regex: new RegExp(`LatchSetup${"4"}Water`, "g")
  }
];

const findings = [];
for await (const file of walk(root)) {
  const relative = path.relative(root, file).replaceAll("\\", "/");
  const text = await readFile(file, "utf8");
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.regex)) {
      const value = match[0];
      if (pattern.allow?.(value, relative)) continue;
      const line = lineNumber(text, match.index || 0);
      findings.push(`${relative}:${line} ${pattern.name}`);
    }
  }
}

if (findings.length) {
  console.error("Secret scan failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log("Secret scan passed.");

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
