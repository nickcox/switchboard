import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { commandLineCaller } from "../../src/caller.ts";
import { configSchema } from "../../src/config.ts";
import { ObjectiveStore } from "../../src/objectives/store.ts";
import { SqliteTaskStore } from "../../src/tasks/sqlite.ts";
import { askPerson, readPersonQuestions } from "../../src/supervise/questions.ts";
import { commandExecutor, registerSupervisor, type SupervisorPi, type SupervisorTool, type SupervisorEvent } from "../../src/hosts/pi/extension.ts";
import { supervisorTools } from "../../src/hosts/pi/tools.ts";
import { resultSummary } from "../../src/hosts/pi/rendering.ts";

type Handler = Parameters<SupervisorPi["on"]>[1];
type Context = NonNullable<Parameters<Handler>[1]>;
type Command = Parameters<SupervisorPi["registerCommand"]>[1];
class FakePi implements SupervisorPi {
  commands = new Map<string, Command>();
  tools = new Map<string, SupervisorTool>();
  handlers = new Map<string, Handler[]>();
  context!: Context;
  registerCommand(name: string, command: Command) { this.commands.set(name, command); }
  registerTool(tool: SupervisorTool) { this.tools.set(tool.name, tool); }
  on(name: string, handler: Handler) { this.handlers.set(name, [...this.handlers.get(name) ?? [], handler]); }
  async sendUserMessage(text: string) { await this.emit("message_start", { message: { role: "user", content: text } }); }
  async emit(name: string, event: Parameters<Handler>[0] = {}) {
    for (const handler of this.handlers.get(name) ?? []) await handler(event, this.context);
  }
  async answer(args = "") { await this.commands.get("answer")!.handler(args, this.context); }
}
const reply = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value) });
async function until(check: () => boolean) {
  for (let i = 0; i < 1000; i++) { if (check()) return; await sleep(5); }
  assert.fail("Timed out waiting for question display");
}
async function fixture(delaysMs?: number[]) {
  const root = resolve(".investigation/pi-questions");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "case-"));
  const config = configSchema.parse({ contextId: "context", runtimeRoot: join(dir, "runtime"), tasks: { repo: "repo" },
    workspaces: { repository: join(dir, "repository"), poolRoot: join(dir, "pool") }, delivery: { baseRef: "main" },
    worker: { piEntrypoint: resolve("tests/fixtures/pi-supervisor.ts"), provider: "fixture", model: "fixture" } });
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  const tasks = await SqliteTaskStore.open({ caller: commandLineCaller(), path: join(config.runtimeRoot, "switchboard.db"), repo: "repo" });
  const objectives = new ObjectiveStore(tasks.database, commandLineCaller());
  await objectives.add({ id: "goal", request: "Useful work", acceptanceCriteria: ["Useful output"] });
  const binding = { objectiveId: "goal", configPath, cliPath: resolve("src/cli.ts"), privateDirectory: dir, sessionId: "session", sessionKind: "restricted" as const,
    ...(delaysMs ? { providerRetries: { delaysMs } } : {}) };
  const execute = commandExecutor(binding);
  const pi = new FakePi();
  const statuses: (string | undefined)[] = [];
  const widgets: (string[] | undefined)[] = [];
  const notices: string[] = [];
  const selections: (string | undefined)[] = [];
  const inputs: (string | undefined)[] = [];
  const calls: string[][] = [];
  const events: SupervisorEvent[] = [];
  let onSelect: (() => Promise<void>) | undefined;
  pi.context = { hasUI: true, ui: {
    setStatus(_key, text) { statuses.push(text); },
    setWidget(key, lines) { assert.equal(key, "switchboard-questions"); widgets.push(lines); },
    async select(_title, options) { await onSelect?.(); const selected = selections.shift(); return selected === "first" ? options[0] : selected === "last" ? options.at(-1) : selected; },
    async input() { return inputs.shift(); },
    notify(text) { notices.push(text); },
  }, sessionManager: { getSessionId: () => "session", getEntries: () => [] } };
  registerSupervisor(pi, binding, async (args, signal) => {
    calls.push(args);
    if (args[0] === "supervise" && args[1] === "wait") {
      while (!events.length) await sleep(5, undefined, { signal });
      return reply({ ok: true, event: events.shift() });
    }
    if (args[0] === "supervise" && args[1] === "handled") return reply({ ok: true });
    return execute(args, signal);
  }, 5);
  const ask = (text = "Which design?", choices?: string[]) => askPerson(tasks.database, { kind: "supervisor", objectiveId: "goal" }, "goal", text, choices);
  return { pi, binding, tasks, objectives, execute, ask, statuses, widgets, notices, selections, inputs, calls, events,
    onSelect(callback: () => Promise<void>) { onSelect = callback; },
    async close() { await pi.emit("session_shutdown"); tasks.close(); },
  };
}

test("all supervisor tools have compact result renderers, expanded JSON and readable refusal reasons", () => {
  for (const tool of Object.values(supervisorTools)) {
    const json = JSON.stringify({ ok: false, reason: "refused", detail: "Target branch moved – use rebase", untouched: [1, 2] }, null, 2);
    const result = { content: [{ type: "text", text: json }], details: JSON.parse(json) };
    const before = structuredClone(result);
    const makeText = (text: string) => ({ render: () => [text], invalidate() {} });
    const collapsed = tool.renderResult(result, { expanded: false }, makeText).render(100).join("\n");
    assert.match(collapsed, /refused: Target branch moved – use rebase/);
    assert.equal(collapsed.split("\n").length, 1);
    assert.equal(tool.renderResult(result, { expanded: true }, makeText).render(100).join("\n"), json);
    assert.match(tool.renderResult(result, { expanded: false, isPartial: true }, makeText).render(100)[0]!, /working/);
    assert.deepEqual(result, before);
    const success = tool.renderResult({ content: [{ type: "text", text: '{"ok":true}' }], details: { ok: true } }, { expanded: false }, makeText).render(100).join("\n");
    assert.ok(success.length < 140);
    assert.doesNotMatch(success, /[{}]/);
  }
  const summary = (command: string, details: unknown) => resultSummary(command, { content: [], details });
  assert.equal(summary("briefing", { ok: true, tasks: [{ state: "in_flight" }, { state: "done" }, { state: "done" }, { state: "queued" }],
    openPersonQuestions: [{}], objective: { spending: { cost: 1.2 }, budget: { maxCost: 15 } } }),
  "Briefing: 4 tasks (1 running, 2 done), 1 open question, $1.20 of $15 spent");
  assert.equal(summary("dispatch", { ok: true, summary: "Generic summary", attempt: { taskId: "cli-help", attempt: 1 } }), "Dispatched cli-help attempt 1");
  assert.match(resultSummary("finish", { content: [{ type: "text", text: "Execution failed" }] }), /Execution failed/);
});

test("record-backed questions appear on startup, refresh after tools and clear after an external answer event", async () => {
  const f = await fixture();
  try {
    const question = await f.ask(undefined, ["Small", "Large"]);
    await f.pi.emit("session_start");
    assert.match(f.widgets.at(-1)!.join("\n"), /Which design\?\n  1\. Small\n  2\. Large\nAnswer with \/answer/);
    assert.match(f.statuses.at(-1)!, /waiting for the person's answer/);
    await f.pi.emit("agent_start");
    assert.match(f.statuses.at(-1)!, /waiting for the person's answer/);
    await f.pi.tools.get("sb_ask")!.execute("new-question", { text: "When?" });
    assert.match(f.widgets.at(-1)!.join("\n"), /When\?/);
    await f.execute(["objective", "answer", "goal", "--question", question.id, "--config", f.calls[0]![f.calls[0]!.indexOf("--config") + 1]!, "--", "Small"]);
    const other = readPersonQuestions(f.tasks.database, "goal").find(q => !q.answer)!;
    // The question shown comes from records, not the event's content.
    f.events.push({ id: "external-answer", kind: "person_answered", taskId: null, attempt: null });
    await until(() => !f.widgets.at(-1)?.some(line => line.includes("Which design?")));
    assert.match(f.widgets.at(-1)!.join("\n"), /When\?/);
    await f.pi.answer("Tomorrow");
    assert.equal(f.widgets.at(-1), undefined);
    assert.equal(readPersonQuestions(f.tasks.database, "goal").find(q => q.id === other.id)!.answer!.text, "Tomorrow");
  } finally { await f.close(); }
  assert.equal(f.statuses.at(-1), undefined);
  assert.equal(f.widgets.at(-1), undefined);
});

test("a new extension session restores open questions from records and clears its waiting footer after an external answer", async () => {
  const f = await fixture();
  const replacement = new FakePi();
  try {
    const question = await f.ask();
    await f.pi.emit("session_start");
    await f.pi.emit("session_shutdown");
    replacement.context = f.pi.context;
    const events: SupervisorEvent[] = [];
    registerSupervisor(replacement, { ...f.binding, sessionId: "replacement" }, async (args, signal) => {
      if (args[0] === "supervise" && args[1] === "wait") {
        while (!events.length) await sleep(5, undefined, { signal });
        return reply({ ok: true, event: events.shift() });
      }
      if (args[0] === "supervise" && args[1] === "handled") return reply({ ok: true });
      return f.execute(args, signal);
    }, 5);
    await replacement.emit("session_start");
    assert.match(f.widgets.at(-1)!.join("\n"), /Which design/);
    assert.match(f.statuses.at(-1)!, /waiting for the person's answer/);
    const answered = await f.execute(["objective", "answer", "goal", "--question", question.id, "--config", f.binding.configPath, "--", "Small"]);
    assert.equal(answered.exitCode, 0);
    events.push({ id: "answered-after-restart", kind: "person_answered", taskId: null, attempt: null });
    await until(() => f.widgets.at(-1) === undefined);
    assert.doesNotMatch(f.statuses.at(-1) ?? "", /waiting for the person's answer/);
  } finally { await replacement.emit("session_shutdown"); await f.close(); }
});

for (const argument of ["2", "A custom answer", "--a literal answer", "  Keep whitespace  "]) test(`/answer records the person's ${argument === "2" ? "choice text" : "text"} through the ordinary CLI: ${argument}`, async () => {
  const f = await fixture();
  try {
    const question = await f.ask(undefined, ["Small", "Large"]);
    await f.pi.emit("session_start");
    await f.pi.answer(argument);
    const answer = readPersonQuestions(f.tasks.database, "goal")[0]!.answer!;
    assert.equal(answer.text, argument === "2" ? "Large" : argument);
    const caller = commandLineCaller();
    assert.equal(caller.kind, "person");
    assert.equal(answer.answeredBy, caller.kind === "person" ? caller.id : "not a person");
    assert.equal(f.objectives.show("goal").personInterventions.count, 1);
    assert.ok(f.calls.some(args => args[0] === "objective" && args[1] === "answer" && args.includes(question.id)));
    assert.ok(!f.calls.some(args => args[0] === "supervise" && args[1] === "answer"));
    assert.match(f.notices.at(-1)!, /Answer recorded/);
    assert.equal(f.widgets.at(-1), undefined);
  } finally { await f.close(); }
});

test("/answer selects among several questions with or without an argument, supports typed answers and cancellation", async () => {
  const f = await fixture();
  try {
    await f.ask("First?", ["One", "Two"]);
    await f.ask("Second?");
    await f.pi.emit("session_start");
    await f.pi.answer("1"); // Cancel the question picker.
    assert.equal(readPersonQuestions(f.tasks.database, "goal").filter(q => q.answer).length, 0);
    f.selections.push("first", "last");
    f.inputs.push("Typed in a dialog");
    await f.pi.answer();
    assert.equal(readPersonQuestions(f.tasks.database, "goal")[0]!.answer!.text, "Typed in a dialog");
    f.inputs.push(undefined);
    await f.pi.answer();
    assert.equal(readPersonQuestions(f.tasks.database, "goal")[1]!.answer, null);
    f.inputs.push("Free text");
    await f.pi.answer();
    assert.equal(readPersonQuestions(f.tasks.database, "goal")[1]!.answer!.text, "Free text");
    await f.pi.answer("Nothing");
    assert.match(f.notices.at(-1)!, /No open questions/);
  } finally { await f.close(); }
});

test("/answer chooses a question for an argument, rejects invalid choice numbers and offers numbered choices in a dialog", async () => {
  const f = await fixture();
  try {
    await f.ask("First?", ["One", "Two"]);
    await f.ask("Second?", ["Three", "Four"]);
    await f.pi.emit("session_start");
    f.selections.push("last");
    await f.pi.answer("2");
    assert.equal(readPersonQuestions(f.tasks.database, "goal")[1]!.answer!.text, "Four");
    await f.pi.answer("99");
    assert.match(f.notices.at(-1)!, /No such choice/);
    assert.equal(readPersonQuestions(f.tasks.database, "goal")[0]!.answer, null);
    f.selections.push("first");
    await f.pi.answer();
    assert.equal(readPersonQuestions(f.tasks.database, "goal")[0]!.answer!.text, "One");
  } finally { await f.close(); }
});

test("a competing terminal answer is refused in Pi with the first answer shown", async () => {
  const f = await fixture();
  try {
    const question = await f.ask(undefined, ["Small", "Large"]);
    await f.pi.emit("session_start");
    f.onSelect(async () => {
      const config = f.calls[0]![f.calls[0]!.indexOf("--config") + 1]!;
      await f.execute(["objective", "answer", "goal", "--question", question.id, "--config", config, "--", "Already answered"]);
    });
    f.selections.push("first");
    await f.pi.answer();
    assert.match(f.notices.at(-1)!, /Answer refused:.*already answered.*Already answered/);
    assert.equal(f.widgets.at(-1), undefined);
  } finally { await f.close(); }
});

for (const retrying of [false, true]) test(`open questions do not override a ${retrying ? "retrying" : "stopped"} footer`, async () => {
  const f = await fixture(retrying ? [60000] : undefined);
  try {
    await f.ask();
    await f.pi.emit("session_start");
    await f.pi.emit("agent_start");
    await f.pi.emit("message_end", { message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Provider unavailable" } });
    await f.pi.emit("agent_settled");
    assert.match(f.statuses.at(-1)!, retrying ? /provider error, retry/ : /stopped after a provider error/);
    assert.match(f.widgets.at(-1)!.join("\n"), /Which design/);
  } finally { await f.close(); }
});
