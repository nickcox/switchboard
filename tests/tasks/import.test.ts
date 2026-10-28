import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { MarkdownStore } from "tasks-axi/dist/src/backends/markdown.js";
import { readyTasks } from "tasks-axi/dist/src/derive.js";
import { LegacyAttempts } from "../fixtures/legacy-attempts.ts";
import { configSchema } from "../../src/config.ts";
import { requireSettled } from "../../src/tasks/import.ts";
import { importTasks, SqliteTaskStore } from "../caller.ts";
import { LegacyRuntimeFixture as RuntimeRecords } from "../fixtures/legacy-runtime.ts";
import { randomUUID } from "node:crypto";

const cli = resolve("src/cli.ts");
async function fixture() {
  const root = resolve(".investigation/import-unit");
  await mkdir(root, { recursive: true });
  const dir = await realpath(await mkdtemp(join(root, "case-")));
  const backlog = join(dir, "backlog.md");
  const archive = join(dir, "done-archive.md");
  const source = `# Backlog\n\n## In flight\n- [ ] running - Running (repo: fixture)\n  Running body\n\n## Queued\n- [ ] b - Second (repo: fixture) blocked-by: archived\n  Body α\n- [ ] a - First (repo: fixture)\n- [ ] held - Waiting (repo: fixture) (hold: Operator)\n- [ ] blocked - Blocked (repo: fixture) blocked-by: a\n- [ ] missing - Missing blocker (repo: fixture) blocked-by: absent\n- [ ] other - Other (repo: other) (kind: scout)\n\n## Done\n- [x] complete - Complete (repo: fixture)\n`;
  await writeFile(backlog, source);
  // The format tasks-axi writes: entries under `## Archived <date>` headings, which its own parser does not read.
  await writeFile(archive, "\n## Archived 2026-10-20\n- [x] archived - Archived (repo: fixture)\n  Retained archived body\n\n## Archived 2026-10-21\n- [x] later - Archived later (repo: fixture)\n");
  const config = configSchema.parse({ contextId: "import-fixture", runtimeRoot: join(dir, "runtime"), tasks: { repo: "fixture" },
    workspaces: { repository: join(dir, "repository"), poolRoot: join(dir, "pool") }, delivery: { baseRef: "main" },
    worker: { piEntrypoint: cli, provider: "fixture", model: "fixture" } });
  const configFile = join(dir, "switchboard.json");
  await writeFile(configFile, JSON.stringify(config));
  return { dir, backlog, archive, source, config, configFile, path: join(config.runtimeRoot, "switchboard.db") };
}

test("import uses tasks-axi's parser, includes its archive and preserves fields, order and ready", async () => {
  const f = await fixture();
  const archiveBefore = await readFile(f.archive, "utf8");
  const result = await importTasks(f.config, f.backlog);
  assert.equal(result.count, 10);
  assert.deepEqual(result.dropped, [{ task: "missing", blocker: "absent" }]);
  const store = await SqliteTaskStore.open({ path: f.path, repo: "fixture" });
  try {
    assert.partialDeepStrictEqual(await store.read("archived"), { state: "done", body: "Retained archived body" });
    assert.partialDeepStrictEqual(await store.read("later"), { state: "done", title: "Archived later" });
    assert.partialDeepStrictEqual(await store.read("held"), { state: "queued", holdReason: "Operator", held: true });
    // Import can preserve an in-flight task without any attempt, which status must still report.
    assert.deepEqual(await store.inFlight(), ["running"]);
    assert.equal(Number(store.database.get("SELECT count(*) AS n FROM attempts")!.n), 0);
    assert.deepEqual((await store.read("b"))?.blockedBy, ["archived"]);
    assert.deepEqual((await store.read("missing"))?.blockedBy, []);
    // Archived tasks are done, and tasks-axi treats a blocker it cannot find as done, so the backlog alone gives tasks-axi's ready list.
    const tasks = (await new MarkdownStore({ path: f.backlog }).list({})).items;
    assert.deepEqual(await store.ready(), readyTasks(tasks).filter(t => t.repo === "fixture").map(t => t.id));
    const ready = spawnSync(process.execPath, [cli, "task", "ready", "--json", "--config", f.configFile], { encoding: "utf8" });
    assert.equal(ready.status, 0, ready.stderr);
    assert.deepEqual(JSON.parse(ready.stdout).ready, await store.ready());
  } finally { store.close(); }
  assert.equal(await readFile(f.backlog, "utf8"), f.source);
  assert.equal(await readFile(f.archive, "utf8"), archiveBefore);
  await assert.rejects(importTasks(f.config, f.backlog), /already activated/);
});

test("import CLI validates usage and reports activation and repeat refusal as JSON", async () => {
  const f = await fixture();
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, "import", ...args, "--json", "--config", f.configFile], { encoding: "utf8" });
  assert.equal(run().status, 2);
  const activated = run("--tasks-axi", f.backlog, "--archive", f.archive);
  assert.equal(activated.status, 0, activated.stderr + activated.stdout);
  assert.equal(JSON.parse(activated.stdout).count, 10);
  const repeat = run("--tasks-axi", f.backlog);
  assert.equal(repeat.status, 1, repeat.stderr);
  assert.equal(JSON.parse(repeat.stdout).reason, "rejected");
});

test("a task line the parser does not read refuses the import instead of skipping the task", async () => {
  const f = await fixture();
  await writeFile(f.archive, "\n## Unrecognised heading\n- [x] lost - Lost (repo: fixture)\n");
  await assert.rejects(importTasks(f.config, f.backlog), /Parsed .* of 1 archived tasks/);
  await assert.rejects(readFile(f.path), { code: "ENOENT" });
});

test("an explicit archive path is read, missing default archive is allowed", async () => {
  for (const explicit of [true, false]) {
    const f = await fixture();
    const result = await importTasks(f.config, f.backlog, explicit ? f.archive : join(f.dir, "missing.md"));
    assert.equal(result.count, explicit ? 10 : 8);
  }
});

test("validation refuses before activation, leaves no staging file, and a later run starts afresh without changing the backlog", async () => {
  const f = await fixture();
  await writeFile(f.backlog, f.source.replace("a - First (repo: fixture)", "a - First (repo: fixture) blocked-by: blocked"));
  await assert.rejects(importTasks(f.config, f.backlog), /cycle/);
  await assert.rejects(readFile(f.path), { code: "ENOENT" });
  assert.deepEqual((await readdir(dirname(f.path))).filter(name => name.includes(".import-")), []);
  await writeFile(f.backlog, f.source);
  assert.equal((await importTasks(f.config, f.backlog)).ok, true);
  assert.equal(await readFile(f.backlog, "utf8"), f.source);
});

test("duplicate IDs or invalid dependencies refuse without activating", async () => {
  for (const cycle of [false, true]) {
    const f = await fixture();
    if (cycle) await writeFile(f.backlog, f.source.replace("a - First (repo: fixture)", "a - First (repo: fixture) blocked-by: blocked"));
    else await writeFile(f.archive, "## Done\n- [x] a - Duplicate\n");
    await assert.rejects(importTasks(f.config, f.backlog), cycle ? /cycle/ : /Duplicate/);
    await assert.rejects(readFile(f.path), { code: "ENOENT" });
  }
});

test("two imports at once activate at most one database, and leave no staging files", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([importTasks(f.config, f.backlog), importTasks(f.config, f.backlog)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1, JSON.stringify(results));
  assert.match(String((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason), /activated/);
  assert.deepEqual((await readdir(dirname(f.path))).filter(name => name.includes(".import-")), []);
});

test("an unfinished attempt refuses even before any worker runtime exists", async () => {
  const f = await fixture();
  const attempts = new LegacyAttempts(f.config.runtimeRoot, f.config.contextId);
  await attempts.create("a", {}, 0);
  await assert.rejects(requireSettled(f.config), /every attempt to be settled/);
  await assert.rejects(importTasks(f.config, f.backlog), /every attempt to be settled/);
});

test("count, fields and readiness are independently validated before activation", async t => {
  for (const mismatch of ["count", "field", "ready"]) {
    const f = await fixture();
    if (mismatch === "ready") t.mock.method(SqliteTaskStore.prototype, "ready", async () => []);
    else {
      const original = SqliteTaskStore.prototype.list;
      t.mock.method(SqliteTaskStore.prototype, "list", async function(this: SqliteTaskStore) {
        const rows = await original.call(this);
        if (mismatch === "count") rows.pop();
        else rows[0]!.title = "Incorrect";
        return rows;
      });
    }
    try {
      await assert.rejects(importTasks(f.config, f.backlog));
      await assert.rejects(readFile(f.path), { code: "ENOENT" });
      assert.equal(await readFile(f.backlog, "utf8"), f.source);
    } finally { t.mock.restoreAll(); }
    assert.equal((await importTasks(f.config, f.backlog)).ok, true);
  }
});

test("a dated hold still in force becomes an ordinary hold, and one whose date has passed is dropped", async () => {
  for (const until of ["2000-01-01", "9999-01-01"]) {
    const f = await fixture();
    await writeFile(f.backlog, f.source.replace("(hold: Operator)", `(hold: Operator) (hold-until: ${until})`));
    const result = await importTasks(f.config, f.backlog);
    const kept = until === "9999-01-01";
    assert.deepEqual(result.timedHolds, [{ task: "held", until, kept }]);
    const store = await SqliteTaskStore.open({ path: f.path, repo: "fixture" });
    try {
      assert.partialDeepStrictEqual(await store.read("held"), { holdReason: kept ? "Operator" : null, held: kept });
      assert.equal((await store.ready()).includes("held"), !kept);
    } finally { store.close(); }
  }
});

test("an unobserved worker or a fresh dispatcher heartbeat refuses import even with no open attempt", async () => {
  const f = await fixture();
  const workspace = join(f.dir, "workspace");
  await mkdir(workspace);
  const runtime = new RuntimeRecords(f.config.runtimeRoot);
  const input = {
    identity: { contextId: f.config.contextId, taskId: "a", leaseId: randomUUID(), sessionId: randomUUID() },
    workspace, instructions: "Fixture", acceptanceCriteria: [], delivery: {
      baseRef: "main", startingCommit: "a".repeat(40), outputBranch: "fixture/a", kind: "code" as const,
      acceptance: "review_or_integration" as const, requiredEvidence: [], requiredDeliverables: [],
    },
  };
  const record = await runtime.reserve(input);
  await assert.rejects(importTasks(f.config, f.backlog), /may still be running/);
  await runtime.recordOperatorStop(record);
  await requireSettled(f.config);
  // A fresh dispatcher heartbeat refuses the import; a stale one does not.
  const heartbeat = (at: Date) => writeFile(join(record.directory, "heartbeat.json"), JSON.stringify({ version: 1, pid: process.pid, at: at.toISOString() }));
  await heartbeat(new Date());
  await assert.rejects(importTasks(f.config, f.backlog), /heartbeat is fresh/);
  await heartbeat(new Date(Date.now() - 60_000));
  await requireSettled(f.config);
});
