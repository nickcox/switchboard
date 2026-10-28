import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { RuntimeRecords, readJsonFile } from "../../src/runtime/records.ts";
import { fixture, resultFor, withRuntimeDatabase } from "../helpers.ts";

const posixOnly = { skip: process.platform === "win32" };

test("reserved identity is discoverable without memory; no exit receipt means unknown, not absent", async () => {
  const f = fixture();
  const reserved = await f.records.reserve(f.input);
  const fresh = new RuntimeRecords(join(f.dir, "runtime"));
  const discovered = await fresh.discover(f.input.identity.contextId);
  assert.equal(discovered.length, 1);
  assert.deepEqual(discovered[0]?.binding.input.identity, f.input.identity);
  assert.equal(discovered[0]?.child.status, "unknown");
  assert.equal(reserved.binding.resultPath.startsWith(f.input.workspace), false);
});

test("one lease cannot launch another session, even after a child-exit observation", async () => {
  const f = fixture();
  const reserved = await f.records.reserve(f.input);
  // Synthetic observed-exit record; no child is started by this unit test.
  await f.records.recordChildExit(reserved, { started: true, code: 0, signal: null });
  await assert.rejects(f.records.reserve({ ...f.input, identity: { ...f.input.identity, sessionId: randomUUID() } }));
  const discovered = await f.records.discover(f.input.identity.contextId);
  assert.equal(discovered[0]?.child.status, "exited");
  const other = { ...f.input, identity: { ...f.input.identity, contextId: "another-context", sessionId: randomUUID() } };
  await f.records.reserve(other);
  assert.equal((await f.records.discover("another-context")).length, 1);
});

test("launch rows are immutable and cannot be removed while their attempt exists", async () => {
  const f = fixture();
  const reserved = await f.records.reserve(f.input);
  await withRuntimeDatabase(f.records, async database => {
    await assert.rejects(database.transaction(() => database.run("UPDATE launches SET binding = '{}' WHERE directory = ?", reserved.directory)), /cannot be changed/);
    await assert.rejects(database.transaction(() => database.run("DELETE FROM launches WHERE directory = ?", reserved.directory)), /cannot be removed/);
    assert.equal(database.get("SELECT count(*) AS n FROM launches")!.n, 1);
  });
});

test("exit observations are bound to an existing launch and recorded once", async () => {
  const f = fixture();
  const reserved = await f.records.reserve(f.input);
  await f.records.recordChildExit(reserved, { started: true, code: 0, signal: null });
  await assert.rejects(f.records.recordChildExit(reserved, { started: false, code: null, signal: null }));
  await assert.rejects(f.records.recordChildExit({ directory: join(f.dir, "unknown") }, { started: true, code: 0, signal: null }), /FOREIGN KEY/);
});

test("validated results are recorded once and concurrent writers use the first record", async () => {
  const f = fixture();
  const reserved = await f.records.reserve(f.input);
  const content = resultFor(f.input);
  await writeFile(reserved.binding.resultPath, JSON.stringify(content));
  const recorded = await f.records.recordValidatedResult(reserved);
  const changed = { ...recorded, content: { ...content, summary: "Must not replace the record" } };
  const values = await Promise.all([reserved.storage.recordValidatedResult(reserved.directory, recorded),
    reserved.storage.recordValidatedResult(reserved.directory, changed)]);
  assert.deepEqual(values, [recorded, recorded]);
  await writeFile(reserved.binding.resultPath, JSON.stringify(changed.content));
  assert.deepEqual(await f.records.recordValidatedResult(reserved), recorded);
  const fresh = new RuntimeRecords(join(f.dir, "runtime"));
  const discovered = (await fresh.discover(f.input.identity.contextId))[0]!;
  assert.deepEqual(discovered.validatedResult, recorded);
  assert.match(discovered.resultDiscrepancy ?? "", /differs/);
  await withRuntimeDatabase(f.records, async database => {
    await assert.rejects(database.transaction(() => database.run("UPDATE worker_observations SET value = '{}' WHERE kind = 'validated_result'")), /cannot be changed/);
  });
});

test("schema 6 observations survive migration and can gain a validated result", async () => {
  const f = fixture();
  const reserved = await f.records.reserve(f.input);
  await f.records.recordChildExit(reserved, { started: true, code: 0, signal: null });
  await f.records.recordSessionStart(reserved, "high");
  await withRuntimeDatabase(f.records, async database => {
    await database.transaction(() => {
      database.run("DROP TABLE review_tasks");
      database.run("DROP TRIGGER worker_observations_immutable");
      database.run("ALTER TABLE worker_observations RENAME TO current_observations");
      database.run(`CREATE TABLE worker_observations (
        directory TEXT NOT NULL REFERENCES launches(directory) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('exit','session_start')), recorded_at TEXT NOT NULL,
        value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(directory, kind))`);
      database.run("INSERT INTO worker_observations SELECT * FROM current_observations");
      database.run("DROP TABLE current_observations");
      database.run("CREATE TRIGGER worker_observations_immutable BEFORE UPDATE ON worker_observations BEGIN SELECT RAISE(ABORT, 'Worker observations cannot be changed'); END");
      database.run("DROP TRIGGER task_definition_changed");
      database.run("ALTER TABLE tasks DROP COLUMN acceptance_criteria");
      database.run(`CREATE TRIGGER task_definition_changed AFTER UPDATE OF title, body, repo, kind ON tasks
        WHEN NEW.title IS NOT OLD.title OR NEW.body IS NOT OLD.body OR NEW.repo IS NOT OLD.repo OR NEW.kind IS NOT OLD.kind
        BEGIN UPDATE tasks SET definition_revision = OLD.definition_revision + 1 WHERE id = NEW.id; END`);
      database.run("DROP INDEX tasks_by_objective");
      database.run("ALTER TABLE tasks DROP COLUMN objective_id");
      database.run("DROP TABLE task_changes");
      database.run("DROP TABLE objective_changes");
      database.run("DROP TABLE objectives");
      database.run("PRAGMA user_version = 6");
    });
  });
  const migrated = (await f.records.discover(f.input.identity.contextId))[0]!;
  assert.deepEqual(migrated.child, { status: "exited", exit: { started: true, code: 0, signal: null } });
  assert.equal(migrated.thinkingLevel, "high");
  assert.equal(migrated.validatedResult, undefined);
  await writeFile(reserved.binding.resultPath, JSON.stringify(resultFor(f.input)));
  assert.ok(await f.records.recordValidatedResult(reserved));
});

test("reserve commits launch permission and a fresh claim before its hook, and writes no dispatcher files", async () => {
  const f = fixture();
  const reserved = await f.records.reserve(f.input, async record => {
    assert.equal((await f.records.discover(f.input.identity.contextId)).length, 1);
    const claim = await record.storage.heartbeat(record.claimId);
    assert.equal(claim?.owner_pid, process.pid);
    assert.equal(claim?.released_at, null);
  });
  assert.deepEqual((await readdir(reserved.directory)).sort(), ["artefacts", "sessions"]);
});

test("startup observations are write-once and discovery checks their identity", async () => {
  const f = fixture();
  const reserved = await f.records.reserve(f.input);
  assert.equal((await f.records.discover(f.input.identity.contextId))[0]?.thinkingLevel, undefined);
  await f.records.recordSessionStart(reserved, "high");
  await assert.rejects(f.records.recordSessionStart(reserved, "low"));
  assert.equal((await f.records.discover(f.input.identity.contextId))[0]?.thinkingLevel, "high");
  await assert.rejects(f.records.recordSessionStart({ directory: join(f.dir, "unknown") }, "high"), /FOREIGN KEY/);
});

test("identity and instruction snapshot text are retained without trimming", async () => {
  const f = fixture();
  const input = { ...f.input, instructions: "  Keep this indentation\n" };
  await f.records.reserve(input);
  assert.equal((await f.records.discover(input.identity.contextId))[0]?.binding.input.instructions, input.instructions);
});

test("a symlinked runtime context cannot redirect evidence into the workspace", posixOnly, async () => {
  const f = fixture();
  const root = join(f.dir, "runtime");
  await mkdir(root);
  const key = createHash("sha256").update(f.input.identity.contextId).digest("hex");
  await symlink(f.input.workspace, join(root, key));
  await assert.rejects(f.records.reserve(f.input), /Unsafe/);
  await assert.rejects(f.records.discover(f.input.identity.contextId), /Unsafe/);
});

test("relative workspace paths are refused rather than resolved through an incidental cwd", async () => {
  const f = fixture();
  await assert.rejects(f.records.reserve({ ...f.input, workspace: "relative" }), /absolute/);
});

test("runtime evidence cannot live under the recyclable workspace", async () => {
  const f = fixture();
  const inside = new RuntimeRecords(join(f.input.workspace, "runtime"));
  await assert.rejects(inside.reserve(f.input), /outside/);
});

test("symlinked JSON results are refused", posixOnly, async () => {
  const f = fixture();
  const file = join(f.dir, "real.json");
  const link = join(f.dir, "link.json");
  await writeFile(file, "{}");
  await symlink(file, link);
  await assert.rejects(readJsonFile(link), /regular/);
  const directory = join(f.dir, "directory");
  await mkdir(directory);
  await assert.rejects(readJsonFile(directory), /regular/);
});

test("an operator stop is recorded once and never overrides an observed exit", async () => {
  const f = fixture();
  const reserved = await f.records.reserve(f.input);
  await f.records.recordOperatorStop(reserved, "Checked by hand");
  const confirmed = (await f.records.discover(f.input.identity.contextId))[0]?.child;
  assert.equal(confirmed?.status, "operator_confirmed_stopped");
  await assert.rejects(f.records.recordOperatorStop(reserved));
  await f.records.recordChildExit(reserved, { started: true, code: 0, signal: null });
  assert.equal((await f.records.discover(f.input.identity.contextId))[0]?.child.status, "exited");
});

test("a JSON read accepts a file at the byte limit and refuses one over it", async () => {
  const f = fixture();
  const path = join(f.dir, "limit.json");
  const value = { text: "x".repeat(5000) };
  await writeFile(path, JSON.stringify(value));
  const size = JSON.stringify(value).length;
  assert.deepEqual(await readJsonFile(path, size), value);
  await assert.rejects(readJsonFile(path, size - 1), /exceeds byte limit/);
  await writeFile(path, "");
  await assert.rejects(readJsonFile(path), SyntaxError);
});
