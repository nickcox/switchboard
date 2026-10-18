import { expect, test } from "bun:test";
import { decode } from "@toon-format/toon";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { command, fixture, node, object, objects, tasksBin, text, type Fixture } from "./helpers.ts";

function store(name: string) {
  const f = fixture(name);
  const file = join(f.dir, "authoritative.md");
  return { ...f, file };
}
function task(f: Fixture & { file: string }, args: string[], options: Parameters<typeof command>[2] = {}) {
  return command(f, [node!, tasksBin, ...args, "--backend", "markdown", "--file", f.file], options);
}
async function show(f: Fixture & { file: string }, id: string) {
  return object(object(decode((await task(f, ["show", id, "--full"])).stdout)).task);
}
async function ready(f: Fixture & { file: string }) {
  const output = object(decode((await task(f, ["ready", "--repo", "fixture"])).stdout));
  return Array.isArray(output.ready) ? objects(output.ready).map(row => row.id) : [];
}

test("absolute --file and explicit backend override cwd, environment and home configuration", async () => {
  const f = store("store-address");
  await task(f, ["add", "address-a1", "Authoritative task", "--repo", "fixture", "--json"]);
  const elsewhere = join(f.dir, "workspace-copy");
  mkdirSync(elsewhere);
  const copy = join(elsewhere, "backlog.md");
  writeFileSync(copy, readFileSync(f.file));
  const initial = readFileSync(copy, "utf8");
  mkdirSync(join(f.env.HOME, ".tasks-axi"));
  writeFileSync(join(f.env.HOME, ".tasks-axi/config.toml"), 'backend = "sqlite"\n[markdown]\npath = "home-copy.md"\n');
  writeFileSync(join(elsewhere, ".tasks.toml"), 'backend = "sqlite"\n[markdown]\npath = "backlog.md"\n');
  await task(f, ["start", "address-a1", "--json"], {
    cwd: elsewhere,
    env: { TASKS_AXI_FILE: copy, TASKS_AXI_BACKEND: "sqlite" },
  });
  expect((await show(f, "address-a1")).state).toBe("in_flight");
  expect(readFileSync(copy, "utf8")).toBe(initial);
});

test("ready ordering follows backlog position, not priority; blocked and held work stay excluded", async () => {
  const f = store("ready");
  await task(f, ["add", "first-b1", "First by position", "--repo", "fixture", "--priority", "4"]);
  await task(f, ["add", "second-a1", "Second by position", "--repo", "fixture", "--priority", "0"]);
  await task(f, ["add", "blocked-c1", "Blocked", "--repo", "fixture", "--blocked-by", "first-b1"]);
  await task(f, ["add", "held-d1", "Held", "--repo", "fixture"]);
  await task(f, ["hold", "held-d1", "--reason", "Awaiting operator", "--json"]);
  expect(await ready(f)).toEqual(["first-b1", "second-a1"]);
  const listed = object(decode((await task(f, ["list", "--state", "queued"])).stdout));
  expect(objects(listed.tasks)).toHaveLength(4);
});

test("read commands use parseable TOON, not a supported --json flag", async () => {
  const f = store("read-formats");
  const body = 'Instructions, commas and "quotes"\n\n## Acceptance\n- keep Unicode: α\n- retain all evidence';
  await task(f, ["add", "format-a1", 'Title, with "quotes"', "--body", body, "--json"]);
  expect((await show(f, "format-a1")).body).toBe(body);
  for (const args of [["ready", "--json"], ["list", "--json"], ["show", "format-a1", "--json"]]) {
    expect((await task(f, args, { allowFailure: true })).code).not.toBe(0);
  }
});

test("start is not a readiness-conditional transition", async () => {
  const f = store("start-policy");
  await task(f, ["add", "blocker-a1", "Blocker"]);
  await task(f, ["add", "blocked-b1", "Blocked task", "--blocked-by", "blocker-a1"]);
  const response = await task(f, ["start", "blocked-b1", "--json"]);
  expect(object(object(JSON.parse(response.stdout)).task).state).toBe("in_flight");
  const inflight = object(decode((await task(f, ["list", "--state", "in_flight"])).stdout));
  expect(objects(inflight.tasks).map(row => row.id)).toEqual(["blocked-b1"]);
});

test("hold does not change state; hold then reopen produces queued held work without unblocking dependants", async () => {
  const f = store("hold-mapping");
  await task(f, ["add", "worker-a1", "Worker", "--repo", "fixture", "--body", "Keep original instructions"]);
  await task(f, ["add", "dependent-b1", "Dependent", "--repo", "fixture", "--blocked-by", "worker-a1"]);
  await task(f, ["start", "worker-a1", "--json"]);
  await task(f, ["hold", "worker-a1", "--reason", "Review required", "--kind", "captain", "--json"]);
  expect((await show(f, "worker-a1")).state).toBe("in_flight");
  const work = { branch: "switchboard/worker-a1/attempt-1", commit: "a".repeat(40), nextAction: "Review retained branch" };
  const body = `Keep original instructions\n\nSwitchboard outcome:\n${JSON.stringify(work)}`;
  await task(f, ["update", "worker-a1", "--body", body, "--json"]);
  await task(f, ["reopen", "worker-a1", "--json"]);
  const observed = await show(f, "worker-a1");
  expect(observed.state).toBe("queued");
  expect(observed.held).toBe("yes");
  expect(observed.hold_reason).toBe("Review required");
  expect(observed.body).toBe(body);
  expect((await show(f, "dependent-b1")).blocked).toBe("yes");
  expect(await ready(f)).toEqual([]);
});

test("confirmed done retains evidence and work references; --no-prune keeps uncertain updates inspectable", async () => {
  const f = store("done-readback");
  await task(f, ["add", "done-a1", "Report task", "--repo", "fixture", "--body", "Acceptance criteria"]);
  await task(f, ["start", "done-a1", "--json"]);
  const note = JSON.stringify({ taskId: "done-a1", leaseId: "lease-1", sessionId: "session-1", evidence: ["Fixture check passed"], branch: "output", resultCommit: "b".repeat(40) });
  // Discard the acknowledgement to simulate losing a successful mutation response.
  await task(f, ["done", "done-a1", "--note", note, "--no-prune", "--json"]);
  const observed = await show(f, "done-a1");
  expect(observed.state).toBe("done");
  expect(text(observed.body)).toContain(note);
  const repeated = object(JSON.parse((await task(f, ["done", "done-a1", "--note", note, "--no-prune", "--json"])).stdout));
  expect(repeated.already).toBe(true);
  expect((await show(f, "done-a1")).body).toBe(observed.body);
});

test("hold reasons and typed report links have format limits; full body can retain arbitrary work references", async () => {
  const f = store("format-limits");
  await task(f, ["add", "limits-a1", "Format limits"]);
  expect((await task(f, ["hold", "limits-a1", "--reason", "Failed (exit 1)", "--json"], { allowFailure: true })).code).not.toBe(0);
  expect((await task(f, ["update", "limits-a1", "--report", "/retained/results/result.json", "--json"], { allowFailure: true })).code).not.toBe(0);
  await task(f, ["update", "limits-a1", "--body", "Result: /retained/results/result.json\nReason: Failed (exit 1)", "--json"]);
  expect(text((await show(f, "limits-a1")).body)).toContain("/retained/results/result.json");
});
