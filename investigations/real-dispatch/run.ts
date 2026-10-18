// Builds a fresh disposable demo (Git repository, tasks-axi store, Switchboard configuration) and, unless
// --setup-only is given, runs one real dispatch with a real Pi worker and checks the result independently.
// Nothing outside the new demo directory is changed. A real dispatch makes model calls on your account.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { onPath } from "../../src/infra/executables.ts";

const usage = `Usage: node investigations/real-dispatch/run.ts --provider <provider> --model <model> [--pi-entrypoint <path>] [--setup-only]

--provider and --model select the worker's model, for example --provider openai-codex --model gpt-6.1-sol.
--pi-entrypoint defaults to the resolved target of \`pi\` on PATH.
--setup-only builds the demo and prints its configuration path without dispatching.`;

const { values } = parseArgs({
  options: {
    provider: { type: "string" }, model: { type: "string" }, "pi-entrypoint": { type: "string" },
    "setup-only": { type: "boolean" }, help: { type: "boolean" },
  },
});
if (values.help || !values.provider || !values.model) {
  console.error(usage);
  process.exit(values.help ? 0 : 2);
}

const root = resolve(import.meta.dirname, "../..");
const cli = join(root, "src/cli.ts");
const tasksAxi = join(root, "node_modules/tasks-axi/dist/bin/tasks-axi.js");
const git = onPath("git");
const piEntrypoint = values["pi-entrypoint"] ? resolve(values["pi-entrypoint"]) : realpathSync(onPath("pi"));

const evidence = join(root, ".investigation/real-dispatch");
mkdirSync(evidence, { recursive: true });
const demo = realpathSync(mkdtempSync(join(evidence, "run-")));
const repository = join(demo, "repo");
const backlog = join(demo, "backlog.md");
const config = join(demo, "switchboard.json");
const run = (args: string[]) => execFileSync(git, ["-c", "core.hooksPath=/dev/null", ...args], { cwd: repository, encoding: "utf8" }).trim();

mkdirSync(repository);
run(["init", "-q", "-b", "main"]);
writeFileSync(join(repository, "README.md"), "# Disposable repository\n");
run(["add", "."]);
// Commits exist only in this disposable demo repository, using your normal Git identity.
run(["commit", "-q", "-m", "Initial commit"]);
const base = run(["rev-parse", "main"]);

const expected = "hello from switchboard";
execFileSync(process.execPath, [
  tasksAxi, "add", "hello-a1", "Add a hello file", "--repo", "demo", "--json", "--backend", "markdown", "--file", backlog,
  "--body", `Create a file named hello.txt containing exactly the line '${expected}', then commit it on the current branch.`,
], { stdio: "ignore" });

writeFileSync(config, `${JSON.stringify({
  contextId: "real-dispatch-demo",
  runtimeRoot: join(demo, "runtime"),
  tasks: { file: backlog, repo: "demo" },
  workspaces: { repository, poolRoot: join(demo, "pool") },
  delivery: { baseRef: "main", requiredEvidence: ["file-check"], requiredDeliverables: ["hello-change"] },
  worker: { piEntrypoint, provider: values.provider, model: values.model, runMs: 600000 },
}, null, 2)}\n`);

console.log(`Demo: ${demo}`);
console.log(`Configuration: ${config}`);
if (values["setup-only"]) {
  console.log(`\nDispatch with: node ${cli} dispatch --once --config ${config}`);
  process.exit(0);
}

const switchboard = (args: string[]) => spawnSync(process.execPath, [cli, ...args, "--config", config, "--json"], { encoding: "utf8" });
const dispatched = switchboard(["dispatch", "--once"]);
if (dispatched.stdout.trim() === "") {
  console.error(dispatched.stderr);
  process.exit(2);
}
const report = JSON.parse(dispatched.stdout);
console.log(`\nDispatch: ${report.reason} (exit ${dispatched.status})`);

// Independent checks: read the repository and task store directly rather than trusting the report.
const branch = report.attempt?.outputBranch as string | undefined;
const show = (args: string[]) => { try { return run(args); } catch { return undefined; } };
const branchHead = branch ? show(["rev-parse", `refs/heads/${branch}`]) : undefined;
const content = branch ? show(["show", `${branch}:hello.txt`]) : undefined;
const task = spawnSync(process.execPath, [tasksAxi, "show", "hello-a1", "--full", "--backend", "markdown", "--file", backlog], { encoding: "utf8" }).stdout;
const checks: [string, boolean][] = [
  ["dispatch held the task for review", report.reason === "held" && report.nextAction?.code === "review_branch"],
  ["output branch head is the reported result commit", branchHead !== undefined && branchHead === report.attempt?.resultCommit],
  ["hello.txt on the output branch has the exact line", content === expected],
  ["main is unchanged", show(["rev-parse", "main"]) === base],
  ["task store shows the task queued and held", /state: queued/.test(task) && /held: yes/.test(task)],
  ["retention check passed", report.retention?.retained === true],
  ["status asks for review", JSON.parse(switchboard(["status"]).stdout).attempts?.[0]?.nextAction?.code === "review_branch"],
];
for (const [name, passed] of checks) console.log(`${passed ? "PASS" : "FAIL"}  ${name}`);
process.exit(checks.every(([, passed]) => passed) ? 0 : 1);
