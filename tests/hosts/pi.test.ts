import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import { configSchema } from "../../src/config.ts";
import { commandLineCaller } from "../../src/caller.ts";
import { ObjectiveStore } from "../../src/objectives/store.ts";
import { SqliteTaskStore } from "../../src/tasks/sqlite.ts";
import { registerSupervisor, commandExecutor, eventText, type SupervisorPi, type SupervisorTool, type SupervisorBinding, type ExecuteCommand, type SupervisorEvent } from "../../src/hosts/pi/extension.ts";
import { prepareSupervisor } from "../../src/hosts/pi/start.ts";
import { supervisorToolNames } from "../../src/hosts/pi/tools.ts";

type Handler = Parameters<SupervisorPi["on"]>[1];
type Event = Parameters<Handler>[0];
type Context = Parameters<Handler>[1];
class FakePi implements SupervisorPi {
  tools = new Map<string, SupervisorTool>();
  handlers = new Map<string, Handler[]>();
  messages: { text: string; options: { deliverAs: "followUp" } }[] = [];
  registerTool(tool: SupervisorTool) { this.tools.set(tool.name, tool); }
  on(name: string, handler: Handler) {
    this.handlers.set(name, [...this.handlers.get(name) ?? [], handler]);
  }
  sendUserMessage(text: string, options: { deliverAs: "followUp" }): void | Promise<void> { this.messages.push({ text, options }); }
  async emit(name: string, event: Event = {}, context?: Context) { for (const handler of this.handlers.get(name) ?? []) await handler(event, context); }
}
async function directory() {
  const root = resolve(".investigation/pi-host");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, "case-"));
}
async function binding(): Promise<SupervisorBinding> {
  const dir = await directory();
  return { objectiveId: "fixed-objective", configPath: join(dir, "config.json"), cliPath: resolve("src/cli.ts"), privateDirectory: dir, sessionId: "fixed-session" };
}
const reply = (value: unknown, exitCode = 0) => ({ exitCode, stdout: JSON.stringify(value) + "\n" });
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await sleep(2); }
  assert.fail("Timed out waiting for extension");
}
test("the portable supervisor skill has valid frontmatter, stays short and names only registered tools", async () => {
  const skill = await readFile("skills/switchboard-supervisor/SKILL.md", "utf8");
  // This deliberately accepts only plain YAML scalars, so malformed YAML cannot pass.
  const frontmatter = /^---\nname: ([a-z0-9]+(?:-[a-z0-9]+)*)\ndescription: ([A-Za-z][A-Za-z0-9 ,.'()-]*)\n---\n/.exec(skill);
  assert.ok(frontmatter, "Expected name and description as valid YAML plain scalars");
  assert.equal(frontmatter[1], "switchboard-supervisor");
  assert.ok(frontmatter[1]!.length <= 64);
  assert.ok(frontmatter[2]!.length <= 1024);
  assert.ok(skill.trimEnd().split("\n").length < 150);
  const pi = new FakePi();
  registerSupervisor(pi, await binding());
  const mentioned = [...skill.matchAll(/\bsb_[a-z0-9_]+\b/g)].map(match => match[0]);
  assert.ok(mentioned.length > 0);
  for (const name of mentioned) assert.ok(pi.tools.has(name), `Unregistered tool ${name}`);
});

const statements = [{ position: 1, statement: "Met", references: [{ kind: "accepted_commit", contextId: "context", taskId: "task", attempt: 1, commit: "a".repeat(40) }] }];
const cases: [string, Record<string, unknown>, string[]][] = [
  ["briefing", {}, []], ["note", { text: "A note" }, ["A note"]],
  ["ask", { text: "Which?", choices: ["One", "Two"] }, ["--choice", "One", "--choice", "Two", "Which?"]],
  ["objective show", {}, []], ["objective complete", { statements }, []],
  ["task add", { id: "task", title: "A task", body: "Instructions\n", criteria: ["First", "Second"], repo: "repo", kind: "code" }, ["--title", "A task", "--repo", "repo", "--kind", "code", "task"]],
  ["task show", { id: "task" }, ["task"]], ["task list", { repo: "repo", state: "queued" }, ["--repo", "repo", "--state", "queued"]],
  ["task update", { id: "task", title: "Changed", body: "New instructions", criteria: [] }, ["--title", "Changed", "task"]],
  ["task hold", { id: "task", reason: "Waiting" }, ["--reason", "Waiting", "task"]],
  ["task release", { id: "task" }, ["task"]],
  ["task block", { id: "task", by: "blocker" }, ["--by", "blocker", "task"]],
  ["task unblock", { id: "task", by: "blocker" }, ["--by", "blocker", "task"]],
  ["task done", { id: "task", note: "Done" }, ["--note", "Done", "task"]],
  ["dispatch", { task: "task", fromAttempt: 2, note: "Repair", dryRun: true }, ["--task", "task", "--from-attempt", "2", "--dry-run"]],
  ["review", { task: "task", attempt: 2 }, ["--task", "task", "--attempt", "2"]],
  ["answer", { task: "task", question: "q", text: "Answer", wait: 3 }, ["--task", "task", "--question", "q", "--wait", "3", "Answer"]],
  ["steer", { lease: "lease", text: "Continue", after: true, label: "Supervisor", wait: 3 }, ["--lease", "lease", "--after", "--as", "Supervisor", "--wait", "3", "Continue"]],
  ["stop", { task: "task", attempt: 2 }, ["--task", "task", "--attempt", "2"]],
  ["finish", { task: "task", acceptOutput: true, rebase: true, dryRun: false }, ["--task", "task", "--accept-output", "--rebase"]],
];

test("every Pi tool runs its operation with fixed authority, private file inputs and unchanged JSON", async () => {
  const b = await binding();
  const pi = new FakePi();
  let expectedOperation = "";
  let expectedParams: Record<string, unknown> = {};
  let observed: string[] = [];
  const json = ' {"ok":false,"reason":"fixture","untouched":[1,2]}\n';
  const run: ExecuteCommand = async args => {
    const prefix = ["supervise", ...expectedOperation.split(" "), "--objective", b.objectiveId, "--config", b.configPath];
    assert.deepEqual(args.slice(0, prefix.length), prefix);
    observed = [];
    const rest = args.slice(prefix.length);
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (["--body-file", "--criteria-file", "--note-file", "--statements-file"].includes(arg)) {
        const path = rest[++i]!;
        assert.ok(path.startsWith(b.privateDirectory));
        const value = await readFile(path, "utf8");
        const expected = arg === "--body-file" ? expectedParams.body : arg === "--criteria-file" ? (expectedParams.criteria as string[]).join("\n")
          : arg === "--note-file" ? expectedParams.note : JSON.stringify(expectedParams.statements);
        if (arg === "--statements-file") assert.deepEqual(JSON.parse(value), JSON.parse(String(expected)));
        else assert.equal(value, expected);
        if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
      } else if (arg === "--request-id") { assert.match(rest[++i]!, /^pi-[a-f0-9]{64}$/); }
      else if (arg !== "--") observed.push(arg);
    }
    return { exitCode: 1, stdout: json };
  };
  registerSupervisor(pi, b, run);
  assert.deepEqual([...pi.tools.keys()], supervisorToolNames);
  assert.equal(pi.tools.has("sb_wait"), false);
  assert.equal(pi.tools.has("sb_handled"), false);
  for (const [operation, params, args] of cases) {
    expectedOperation = operation;
    expectedParams = params;
    const tool = pi.tools.get(`sb_${operation.replaceAll(" ", "_")}`)!;
    assert.ok(tool, operation);
    const result = await tool.execute("call-1", params);
    assert.equal(result.content[0]!.text, json);
    assert.deepEqual(result.details, JSON.parse(json));
    assert.deepEqual(observed, args, operation);
    for (const key of ["objective", "objectiveId", "config", "configPath", "caller", "requestId", "request-id"]) {
      assert.equal(Object.hasOwn(tool.parameters.properties as object, key), false);
      await assert.rejects(tool.execute("bad-call", { ...params, [key]: "injected" }));
    }
    assert.deepEqual(await readdir(b.privateDirectory), []);
  }
});

test("ask and dispatch retries use the tool call identity, not parameters or newly generated IDs", async () => {
  const b = await binding();
  const pi = new FakePi();
  const requests = new Map<string, unknown>();
  const ids: string[] = [];
  registerSupervisor(pi, b, async args => {
    const id = args[args.indexOf("--request-id") + 1]!;
    ids.push(id);
    if (!requests.has(id)) requests.set(id, args[1] === "ask" ? { question: { id: `question-${requests.size}` } } : { attempt: { attempt: requests.size + 1 } });
    return reply(requests.get(id));
  });
  for (const name of ["sb_ask", "sb_dispatch"]) {
    const tool = pi.tools.get(name)!;
    const params = name === "sb_ask" ? { text: "Which?" } : { task: "task" };
    assert.deepEqual(await tool.execute("same-call", params), await tool.execute("same-call", params));
    await tool.execute("another-call", params);
  }
  assert.equal(ids[0], ids[1]);
  assert.equal(ids[3], ids[4]);
  assert.notEqual(ids[0], ids[2]);
  assert.notEqual(ids[0], ids[3]);
  const otherPi = new FakePi();
  registerSupervisor(otherPi, { ...b, sessionId: "another-session" }, async args => { assert.notEqual(args[args.indexOf("--request-id") + 1], ids[0]); return reply({}); });
  await otherPi.tools.get("sb_ask")!.execute("same-call", { text: "Which?" });
});

const event: SupervisorEvent = { id: "event-1", kind: "worker_finished", taskId: "task", attempt: 2, details: { outcome: "completed" } };
for (const hook of ["before_agent_start", "message_start"]) {
  test(`events are serial follow-ups; ${hook} confirms delivery before handled; failures retry`, async () => {
    const pi = new FakePi();
    const calls: string[] = [];
    let failedWait = false;
    let failedHandled = false;
    let acknowledged = false;
    registerSupervisor(pi, await binding(), async (args, signal) => {
      const operation = args[1]!;
      if (operation === "usage") return reply({ ok: true });
      calls.push(operation);
      if (operation === "wait") {
        if (!failedWait) { failedWait = true; throw new Error("Wait unavailable"); }
        if (acknowledged) { await sleep(10000, undefined, { signal }); return reply({ ok: true, event: null }); }
        return reply({ ok: true, event });
      }
      assert.equal(operation, "handled");
      assert.equal(args.at(-1), event.id);
      assert.equal(pi.messages.length, 1);
      if (!failedHandled) { failedHandled = true; return reply({ ok: false }, 1); }
      acknowledged = true;
      return reply({ ok: true });
    }, 5);
    try {
      await pi.emit("session_start");
      await until(() => pi.messages.length === 1);
      assert.deepEqual(pi.messages[0], { text: eventText(event), options: { deliverAs: "followUp" } });
      assert.match(pi.messages[0]!.text.split("\n")[0]!, /event-1.*worker_finished.*task.*2.*Read the briefing/);
      assert.deepEqual(JSON.parse(pi.messages[0]!.text.slice(pi.messages[0]!.text.indexOf("\n") + 1)), event);
      await sleep(15);
      assert.deepEqual(calls, ["wait", "wait"]);
      await pi.emit("agent_end");
      await pi.emit(hook, { prompt: "Not the event", message: { role: "assistant", content: eventText(event) } });
      assert.equal(acknowledged, false);
      await pi.emit(hook, hook === "before_agent_start" ? { prompt: eventText(event) } : { message: { role: "user", content: [{ type: "text", text: eventText(event) }] } });
      await until(() => acknowledged && calls.at(-1) === "wait");
      assert.deepEqual(calls, ["wait", "wait", "handled", "handled", "wait"]);
    } finally { await pi.emit("session_shutdown"); }
  });
}

test("an event queued but lost before delivery is not acknowledged and is delivered again after restart", async () => {
  const b = await binding();
  let handled = 0;
  const run: ExecuteCommand = async args => { if (args[1] === "usage") return reply({ ok: true }); if (args[1] === "handled") handled++; return reply({ ok: true, event }); };
  for (let i = 0; i < 2; i++) {
    const pi = new FakePi();
    registerSupervisor(pi, b, run, 5);
    await pi.emit("session_start");
    await until(() => pi.messages.length === 1);
    await pi.emit("session_shutdown");
    assert.equal(handled, 0);
    assert.equal(pi.messages[0]!.text, eventText(event));
  }
});

test("a failed send is retried, never acknowledged just because sendUserMessage resolved", async () => {
  const pi = new FakePi();
  let sends = 0;
  pi.sendUserMessage = (text, options) => { if (++sends === 1) throw new Error("Queue unavailable"); pi.messages.push({ text, options }); };
  let waits = 0;
  registerSupervisor(pi, await binding(), async args => { if (args[1] === "usage") return reply({ ok: true }); assert.equal(args[1], "wait"); waits++; return reply({ ok: true, event }); }, 5);
  await pi.emit("session_start");
  await until(() => pi.messages.length === 1);
  await pi.emit("session_shutdown");
  assert.equal(waits, 2);
  assert.equal(sends, 2);
});

test("idle and busy events are follow-ups, with no second event fetched before the first acknowledgement", async () => {
  const pi = new FakePi();
  const second = { ...event, id: "event-2", kind: "question_asked", attempt: 3 };
  let handled = 0;
  let waits = 0;
  let rejectFirstSend: (error: Error) => void = () => {};
  // Pi can report delivery before the promise from sendUserMessage settles.
  pi.sendUserMessage = (text, options) => {
    pi.messages.push({ text, options });
    if (pi.messages.length === 1) return new Promise<void>((_resolve, reject) => { rejectFirstSend = reject; });
  };
  registerSupervisor(pi, await binding(), async (args, signal) => {
    if (args[1] === "usage") return reply({ ok: true });
    if (args[1] === "handled") { handled++; return reply({ ok: true }); }
    waits++;
    if (handled === 2) { await sleep(10000, undefined, { signal }); return reply({ ok: true, event: null }); }
    return reply({ ok: true, event: handled === 0 ? event : second });
  }, 5);
  try {
    await pi.emit("session_start");
    await until(() => pi.messages.length === 1);
    assert.equal(waits, 1);
    // Delivery while idle starts the first turn.
    await pi.emit("before_agent_start", { prompt: eventText(event) });
    await until(() => pi.messages.length === 2);
    assert.equal(handled, 1);
    assert.equal(waits, 2);
    // A late failure of the first send must not clear the second event's pending delivery.
    rejectFirstSend(new Error("First run ended with an error after delivery"));
    await sleep(15);
    assert.equal(waits, 2);
    assert.equal(handled, 1);
    // The second message was queued while the first turn was busy; it is now delivered.
    await pi.emit("message_start", { message: { role: "user", content: eventText(second) } });
    await until(() => handled === 2);
    assert.deepEqual(pi.messages.map(message => message.options), [{ deliverAs: "followUp" }, { deliverAs: "followUp" }]);
  } finally { await pi.emit("session_shutdown"); }
});

test("shutdown during a wait response never queues an event or leaves delivery pending", { timeout: 2000 }, async () => {
  const pi = new FakePi();
  let waiting = false;
  registerSupervisor(pi, await binding(), async (args, signal) => {
    if (args[1] === "usage") return reply({ ok: true });
    assert.equal(args[1], "wait");
    waiting = true;
    return new Promise(resolve => signal!.addEventListener("abort", () => resolve(reply({ ok: true, event })), { once: true }));
  }, 5);
  await pi.emit("session_start");
  await until(() => waiting);
  await pi.emit("session_shutdown");
  assert.deepEqual(pi.messages, []);
});

test("failed wait responses and thrown acknowledgements retry without fetching past the event", async () => {
  const pi = new FakePi();
  const calls: string[] = [];
  let waits = 0;
  let acknowledgements = 0;
  registerSupervisor(pi, await binding(), async (args, signal) => {
    if (args[1] === "usage") return reply({ ok: true });
    calls.push(args[1]!);
    if (args[1] === "wait") {
      if (++waits === 1) return reply({ ok: false }, 1);
      if (waits === 2) return { exitCode: 0, stdout: "invalid JSON" };
      if (acknowledgements === 2) await sleep(10000, undefined, { signal });
      return reply({ ok: true, event });
    }
    if (++acknowledgements === 1) throw new Error("Acknowledgement unavailable");
    return reply({ ok: true });
  }, 5);
  try {
    await pi.emit("session_start");
    await until(() => pi.messages.length === 1);
    assert.deepEqual(calls, ["wait", "wait", "wait"]);
    await pi.emit("message_start", { message: { role: "user", content: eventText(event) } });
    await until(() => acknowledgements === 2 && waits === 4);
    assert.deepEqual(calls, ["wait", "wait", "wait", "handled", "handled", "wait"]);
    assert.equal(pi.messages.length, 1);
  } finally { await pi.emit("session_shutdown"); }
});

test("a stale dispatcher event tells the supervisor to ask the person, not assume worker exit", () => {
  const text = eventText({ ...event, kind: "dispatcher_heartbeat_stale" });
  assert.match(text.split("\n")[0]!, /worker may still be running; ask the person/);
});

async function objectiveFixture() {
  const dir = await directory();
  const config = configSchema.parse({ contextId: "context", runtimeRoot: join(dir, "runtime"), tasks: { repo: "repo" },
    workspaces: { repository: join(dir, "repository"), poolRoot: join(dir, "pool") }, delivery: { baseRef: "main" },
    worker: { piEntrypoint: resolve("tests/fixtures/pi-supervisor.ts"), provider: "worker-provider", model: "worker-model", thinking: "high" } });
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  const tasks = await SqliteTaskStore.open({ caller: commandLineCaller(), path: join(config.runtimeRoot, "switchboard.db"), repo: "repo" });
  const objectives = new ObjectiveStore(tasks.database, commandLineCaller());
  await objectives.add({ id: "goal", request: "Complete the objective", acceptanceCriteria: ["Met"] });
  return { dir, config, configPath, tasks, objectives };
}

test("launcher fixes the tool allowlist, disables discovery and supplies a persistent routine and private directories", async () => {
  const f = await objectiveFixture();
  try {
    const launch = await prepareSupervisor(f.config, f.configPath, "goal");
    const option = (key: string) => launch.args[launch.args.indexOf(key) + 1]!;
    assert.equal(launch.executable, process.execPath);
    assert.equal(launch.args[0], f.config.worker.piEntrypoint);
    assert.equal(option("--tools"), supervisorToolNames.join(","));
    for (const flag of ["--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve"]) assert.ok(launch.args.includes(flag));
    assert.equal(option("--extension"), resolve("src/hosts/pi/extension.ts"));
    assert.equal(option("--provider"), "worker-provider");
    assert.equal(option("--model"), "worker-model");
    assert.equal(option("--thinking"), "high");
    assert.match(option("--system-prompt"), /Switchboard supervisor/);
    assert.equal(option("--append-system-prompt"), resolve("skills/switchboard-supervisor/SKILL.md"));
    assert.equal(await readFile(option("--append-system-prompt"), "utf8"), await readFile("skills/switchboard-supervisor/SKILL.md", "utf8"));
    assert.equal(launch.args.includes("--skill"), false);
    assert.equal(supervisorToolNames.includes("read"), false);
    assert.match(launch.args.at(-1)!, /sb_briefing/);
    assert.ok(launch.cwd.startsWith(f.config.runtimeRoot));
    assert.ok(option("--session-dir").startsWith(f.config.runtimeRoot));
    assert.ok((await stat(launch.cwd)).isDirectory());
    assert.ok((await stat(option("--session-dir"))).isDirectory());
    const b = JSON.parse(await readFile(launch.env.SWITCHBOARD_SUPERVISOR_BINDING!, "utf8"));
    assert.equal(b.objectiveId, "goal");
    assert.equal(b.configPath, f.configPath);
    assert.equal(b.sessionId, option("--session-id"));
    assert.ok(b.privateDirectory.startsWith(f.config.runtimeRoot));
    f.config.supervisor = { provider: "supervisor-provider", model: "supervisor-model", thinking: "low" };
    const overridden = await prepareSupervisor(f.config, f.configPath, "goal");
    assert.equal(overridden.args[overridden.args.indexOf("--provider") + 1], "supervisor-provider");
    assert.equal(overridden.args[overridden.args.indexOf("--model") + 1], "supervisor-model");
    assert.equal(overridden.args[overridden.args.indexOf("--thinking") + 1], "low");
    assert.notEqual(overridden.cwd, launch.cwd);
    f.config.supervisor = { model: "supervisor-model" };
    const partial = await prepareSupervisor(f.config, f.configPath, "goal");
    assert.equal(partial.args[partial.args.indexOf("--provider") + 1], "worker-provider");
    assert.equal(partial.args[partial.args.indexOf("--thinking") + 1], "high");
    assert.throws(() => configSchema.parse({ ...f.config, supervisor: { thinking: "invalid" } }));
    await assert.rejects(prepareSupervisor(f.config, f.configPath, "missing"), /does not exist/);
    await f.objectives.abandon("goal");
    await assert.rejects(prepareSupervisor(f.config, f.configPath, "goal"), /abandoned/);
  } finally { f.tasks.close(); }
});

test("supervisor start CLI launches the interactive child and refuses a closed objective before launch", async () => {
  const f = await objectiveFixture();
  const log = join(f.dir, "pi.json");
  try {
    const run = () => spawnSync(process.execPath, [resolve("src/cli.ts"), "supervisor", "start", "--objective", "goal", "--config", f.configPath], {
      env: { ...process.env, FAKE_PI_SUPERVISOR_LOG: log }, encoding: "utf8",
    });
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const launched = JSON.parse(await readFile(log, "utf8"));
    assert.ok(launched.args.includes("--extension"));
    assert.equal(launched.args.includes("--mode"), false);
    assert.equal(launched.args.includes("--print"), false);
    assert.ok(launched.cwd.startsWith(f.config.runtimeRoot));
    await f.objectives.abandon("goal");
    const refused = run();
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /abandoned/);
    assert.equal(await readFile(log, "utf8"), JSON.stringify(launched));
  } finally { f.tasks.close(); }
});

test("the real command executor returns an ask replay unchanged from the restricted CLI", async () => {
  const f = await objectiveFixture();
  try {
    const pi = new FakePi();
    registerSupervisor(pi, { ...await binding(), objectiveId: "goal", configPath: f.configPath }, undefined, 5);
    const tool = pi.tools.get("sb_ask")!;
    const first = await tool.execute("ask-1", { text: "Which design?", choices: ["Small", "Large"] });
    const second = await tool.execute("ask-1", { text: "Which design?", choices: ["Small", "Large"] });
    assert.deepEqual(first, second);
    assert.equal((first.details as { ok: boolean }).ok, true);
    const runner = commandExecutor({ ...await binding(), objectiveId: "goal", configPath: f.configPath });
    const refused = await runner(["supervise", "task", "show", "missing", "--objective", "goal", "--config", f.configPath]);
    assert.equal(refused.exitCode, 1);
    assert.equal(JSON.parse(refused.stdout).ok, false);
  } finally { f.tasks.close(); }
});
