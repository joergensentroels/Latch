import { spawnSync } from "node:child_process";

const candidates = [
  ...(process.env.PYTHON ? [[process.env.PYTHON, []]] : []),
  ["python", []],
  ["python3", []],
  ["py", ["-3"]]
];

const tests = [
  "test/worker-readonly-templates.py",
  "test/executor.py"
];

let selected = null;
for (const [command, prefixArgs] of candidates) {
  const probe = spawnSync(command, [...prefixArgs, "--version"], { encoding: "utf8" });
  if (!probe.error && probe.status === 0) {
    selected = [command, prefixArgs];
    break;
  }
}

if (!selected) {
  console.error("No Python interpreter found. Install python3 to run worker tests.");
  process.exit(1);
}

const [command, prefixArgs] = selected;
for (const test of tests) {
  const result = spawnSync(command, [...prefixArgs, test], { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}
