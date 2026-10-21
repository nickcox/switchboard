// Builds a fresh disposable demo (Git repository, SQLite task store, Switchboard configuration) and, unless
// --setup-only is given, runs one real dispatch with a real Pi worker and checks the result independently.
// Nothing outside the new demo directory is changed. A real dispatch makes model calls on your account.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { onPath } from "../../src/infra/executables.ts";
import { isArtefactPath } from "./paths.ts";
import { SqliteTaskStore } from "../../src/tasks/sqlite.ts";

const usage = `Usage: node investigations/real-dispatch/run.ts --provider <provider> --model <model> [--kind code|scout] [--pi-entrypoint <path>] [--setup-only]

--provider and --model select the worker's model, for example --provider openai-codex --model gpt-6.1-sol.
--kind code (the default) asks the worker to commit a file, which is held for review.
--kind scout asks for a report only, under a "scout" contract whose report counts as independently accepted.
--pi-entrypoint defaults to the resolved target of \`pi\` on PATH.
--setup-only builds the demo and prints its configuration path without dispatching.`;

const { values } = parseArgs({
  options: {
    provider: { type: "string" }, model: { type: "string" }, "pi-entrypoint": { type: "string" },
    "setup-only": { type: "boolean" }, help: { type: "boolean" }, kind: { type: "string", default: "code" },
  },
});
if (values.help || !values.provider || !values.model || !["code", "scout"].includes(values.kind)) {
  console.error(usage);
  process.exit(values.help ? 0 : 2);
}

const root = resolve(import.meta.dirname, "../..");
const cli = join(root, "src/cli.ts");
const git = onPath("git");
const piEntrypoint = values["pi-entrypoint"] ? resolve(values["pi-entrypoint"]) : realpathSync(onPath("pi"));

const evidence = join(root, ".investigation/real-dispatch");
mkdirSync(evidence, { recursive: true });
const demo = realpathSync(mkdtempSync(join(evidence, "run-")));
const repository = join(demo, "repo");
const database = join(demo, "runtime", "switchboard.db");
const config = join(demo, "switchboard.json");
const run = (args: string[]) => execFileSync(git, ["-c", "core.hooksPath=/dev/null", ...args], { cwd: repository, encoding: "utf8" }).trim();

mkdirSync(repository);
run(["init", "-q", "-b", "main"]);
writeFileSync(join(repository, "README.md"), "# Disposable repository\n");
run(["add", "."]);
// Commits exist only in this disposable demo repository, using your normal Git identity.
run(["commit", "-q", "-m", "Initial commit"]);
const base = run(["rev-parse", "main"]);

const scout = values.kind === "scout";
const taskId = scout ? "survey-a1" : "hello-a1";
const expected = "hello from switchboard";
const tasks = await SqliteTaskStore.open({ path: database, repo: "demo" });
await tasks.add({
  id: taskId, title: scout ? "Survey the repository" : "Add a hello file", kind: scout ? "scout" : null,
  body: scout
    ? "Write a short Markdown report that lists the files in this repository and summarises README.md. Do not change the repository."
    : `Create a file named hello.txt containing exactly the line '${expected}', then commit it on the current branch.`,
});
tasks.close();

writeFileSync(config, `${JSON.stringify({
  contextId: "real-dispatch-demo",
  runtimeRoot: join(demo, "runtime"),
  tasks: { repo: "demo" },
  workspaces: { repository, poolRoot: join(demo, "pool") },
  delivery: {
    baseRef: "main", requiredEvidence: ["file-check"], requiredDeliverables: ["hello-change"],
    byTaskKind: { scout: { kind: "artefact", acceptance: "independent_deliverable", requiredDeliverables: ["report"] } },
  },
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
console.log(`\nDispatch: ${report.reason}${report.detail ? ` – ${report.detail}` : ""} (exit ${dispatched.status})`);

// Independent checks: read the repository, task store and files directly rather than trusting the report.
const branch = report.attempt?.outputBranch as string | undefined;
const show = (args: string[]) => { try { return run(args); } catch { return undefined; } };
const branchHead = branch ? show(["rev-parse", `refs/heads/${branch}`]) : undefined;
const taskStore = await SqliteTaskStore.open({ path: database, repo: "demo" });
const task = await taskStore.read(taskId);
taskStore.close();
const nextAction = JSON.parse(switchboard(["status"]).stdout).attempts?.[0]?.nextAction?.code;
// Reports written by the worker into any attempt's artefacts directory, outside the workspace.
const reports = (readdirSync(join(demo, "runtime"), { recursive: true }) as string[])
  .filter(isArtefactPath).map(path => join(demo, "runtime", path));
const checks: [string, boolean][] = scout ? [
  ["dispatch recorded the task as done", report.reason === "done"],
  ["task store shows the task done", task?.state === "done"],
  ["a non-empty report exists in the attempt's artefacts directory", reports.some(path => readFileSync(path, "utf8").trim() !== "")],
  ["the output branch has no new commits", branchHead === undefined || branchHead === base],
  ["main is unchanged", show(["rev-parse", "main"]) === base],
  ["retention check passed", report.retention?.retained === true],
  ["status asks for the lease to be returned", nextAction === "finish_attempt"],
] : [
  ["dispatch held the task for review", report.reason === "held" && report.nextAction?.code === "review_then_finish"],
  ["output branch head is the reported result commit", branchHead !== undefined && branchHead === report.attempt?.resultCommit],
  ["hello.txt on the output branch has the exact line", (branch ? show(["show", `${branch}:hello.txt`]) : undefined) === expected],
  ["main is unchanged", show(["rev-parse", "main"]) === base],
  ["task store shows the task queued and held", task?.state === "queued" && task.held],
  ["retention check passed", report.retention?.retained === true],
  ["status asks for review", nextAction === "review_then_finish"],
];
for (const [name, passed] of checks) console.log(`${passed ? "PASS" : "FAIL"}  ${name}`);
if (scout && reports[0]) console.log(`\nReport: ${reports[0]}`);
process.exit(checks.every(([, passed]) => passed) ? 0 : 1);
