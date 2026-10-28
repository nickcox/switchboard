import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SqliteTaskStore } from "../../src/tasks/sqlite.ts";
import { AttemptStore } from "../../src/attempts/store.ts";
import { TaskStoreError } from "../../src/tasks/store.ts";
import { specificationFor } from "../helpers.ts";

const root = resolve(".investigation/tasks-unit");
async function fixture(repo: string | null = "fixture") {
  await mkdir(root, { recursive: true });
  const dir = await realpath(await mkdtemp(join(root, "case-")));
  const path = join(dir, "switchboard.db");
  const store = await SqliteTaskStore.open({ path, repo });
  return { dir, path, store };
}
const rejected = (error: unknown) => error instanceof TaskStoreError && error.reason === "rejected";

async function start(store: SqliteTaskStore, id: string) {
  const attempts = new AttemptStore(store.database, "fixture");
  const { ref } = await attempts.reserveAttempt({ taskId: id, requested: {}, maximum: 100, specification: specificationFor });
  await attempts.append(ref, "leased", { leaseId: id, workspace: store.database.path, baseRef: "main", outputBranch: id, startingCommit: "a".repeat(40) });
  await attempts.startReservedTask(ref);
  return { attempts, ref };
}

test("identity, unique permanent IDs, append-only positions and database-wide repository scope", async () => {
  const { store, path } = await fixture();
  try {
    for (const id of ["a", "B-2._", "123"]) await store.add({ id, title: id });
    for (const id of ["", "a b", "a/b", "α"]) await assert.rejects(store.add({ id, title: id }), rejected);
    await store.done("a");
    await assert.rejects(store.add({ id: "a", title: "Reuse" }), rejected);
    const other = await SqliteTaskStore.open({ path, repo: "other" });
    try {
      assert.equal((await other.read("a"))?.id, "a");
      await assert.rejects(other.add({ id: "a", title: "Duplicate" }), rejected);
      await other.add({ id: "other", title: "Other" });
      assert.deepEqual(await other.ready(), ["other"]);
    } finally { other.close(); }
    assert.deepEqual((await store.list()).map(t => t.position), [1, 2, 3]);
    assert.deepEqual(await store.ready(), ["B-2._", "123"]);
  } finally { store.close(); }
});

test("fields, body fidelity, update, missing reads and persistence across opens", async () => {
  const { store, path } = await fixture();
  const body = 'Instructions, "quotes"\n\n## Acceptance\n- α\n';
  await store.add({ id: "a", title: "123", body, kind: "scout" });
  await store.update("a", { title: "Changed", repo: "other", kind: null });
  assert.partialDeepStrictEqual(await store.read("a"), { title: "Changed", body, repo: "other", kind: null });
  assert.equal(await store.read("missing"), undefined);
  store.close();
  const reopened = await SqliteTaskStore.open({ path });
  try { assert.equal((await reopened.read("a"))?.body, body); } finally { reopened.close(); }
});

test("criteria are ordered definition data and changing several fields increases the revision once", async () => {
  const { store, path } = await fixture();
  try {
    assert.deepEqual((await store.add({ id: "a", title: "A" })).acceptanceCriteria, []);
    const updated = await store.update("a", { title: "B", body: "Instructions", acceptanceCriteria: ["Second", "First", "First"] });
    assert.equal(updated.definitionRevision, 2);
    assert.deepEqual(updated.acceptanceCriteria, ["Second", "First", "First"]);
    assert.equal((await store.update("a", { acceptanceCriteria: [...updated.acceptanceCriteria] })).definitionRevision, 2);
    assert.equal((await store.update("a", { acceptanceCriteria: ["First", "Second", "First"] })).definitionRevision, 3);
    for (const criterion of ["", "  ", "two\nlines"]) {
      await assert.rejects(store.update("a", { acceptanceCriteria: [criterion] }), rejected);
      assert.equal((await store.read("a"))!.definitionRevision, 3);
    }
    assert.equal((await store.update("a", { acceptanceCriteria: [] })).definitionRevision, 4);
    const reopened = await SqliteTaskStore.open({ path });
    try { assert.deepEqual((await reopened.read("a"))!.acceptanceCriteria, []); } finally { reopened.close(); }
  } finally { store.close(); }
});

test("conversion moves only safe queued sections, including held tasks, and leaves all refusals unchanged", async () => {
  const { store } = await fixture();
  try {
    const flat = "Intro\n\n## Acceptance criteria\n\n- First\n* Second\n+ Third\n\n## Notes\nKeep these\n";
    const bodies = {
      flat, held: flat, running: flat, done: flat, existing: flat,
      nested: "## Acceptance criteria\n- First\n  - Nested\n",
      prose: "## Acceptance criteria\nSome prose\n- First\n",
      continuation: "## Acceptance criteria\n- First\n  continued\n",
      repeated: "## Acceptance criteria\n- One\n## Acceptance criteria\n- Two\n",
      empty: "## Acceptance criteria\n\n",
      absent: "No section here",
      fenced: "```md\n## Acceptance criteria\n- Example only\n```\n",
    };
    for (const [id, body] of Object.entries(bodies)) await store.add({ id, title: id, body });
    await store.hold("held", "Waiting");
    await start(store, "running");
    await store.hold("running", "Still running");
    await store.done("done");
    await store.update("existing", { acceptanceCriteria: ["Stored criterion"] });
    const before = await store.list();
    const reports = await store.convertCriteria();
    assert.deepEqual(reports.filter(r => r.status === "converted").map(r => r.id), ["flat", "held"]);
    assert.deepEqual(reports.filter(r => r.status === "unconverted").map(r => r.id), ["running", "done", "existing", "nested", "prose", "continuation", "repeated", "empty"]);
    for (const id of ["flat", "held"]) {
      const task = (await store.read(id))!;
      assert.equal(task.body, "Intro\n\n## Notes\nKeep these\n");
      assert.deepEqual(task.acceptanceCriteria, ["First", "Second", "Third"]);
      assert.equal(task.definitionRevision, 2);
    }
    assert.equal((await store.read("held"))!.holdReason, "Waiting");
    for (const task of before.filter(t => !["flat", "held"].includes(t.id))) assert.deepEqual(await store.read(task.id), task);
    const after = await store.list();
    assert.ok((await store.convertCriteria()).every(r => r.status === "unconverted"));
    assert.deepEqual(await store.list(), after);
  } finally { store.close(); }
});

test("conversion preserves the bytes outside the criteria section, including mixed line endings", async () => {
  const { store } = await fixture();
  try {
    await store.add({ id: "a", title: "A", body: "Intro\r\n\r\n## Acceptance criteria\r\n- First\r\n\r\n## Notes\nKeep these\r\n" });
    assert.deepEqual(await store.convertCriteria(), [{ id: "a", status: "converted" }]);
    assert.equal((await store.read("a"))!.body, "Intro\r\n\r\n## Notes\nKeep these\r\n");
  } finally { store.close(); }
});

test("holds are separate from state, validate atomically, and accept parentheses", async () => {
  const { store } = await fixture();
  try {
    await store.add({ id: "a", title: "A" });
    await start(store, "a");
    await store.hold("a", "Failed (exit 1)");
    assert.partialDeepStrictEqual(await store.read("a"), { state: "in_flight", held: true, holdReason: "Failed (exit 1)" });
    const before = await store.read("a");
    for (const reason of ["", "x\ny", "x\ry", "x".repeat(201)]) {
      await assert.rejects(store.hold("a", reason), rejected);
      assert.deepEqual(await store.read("a"), before);
    }
    await store.hold("a", "x".repeat(200));
    await store.release("a");
    assert.partialDeepStrictEqual(await store.read("a"), { state: "in_flight", held: false });
  } finally { store.close(); }
});

test("dependencies reject missing, self and transitive cycles without changing anything", async () => {
  const { store } = await fixture();
  try {
    for (const id of ["a", "b", "c"]) await store.add({ id, title: id });
    await store.block("a", "b");
    await store.block("b", "c");
    const before = await store.list();
    for (const [id, by] of [["a", "a"], ["a", "missing"], ["c", "a"]]) {
      await assert.rejects(store.block(id!, by!), rejected);
      assert.deepEqual(await store.list(), before);
    }
    await store.block("a", "b");
    assert.deepEqual((await store.read("a"))?.blockedBy, ["b"]);
    await store.unblock("a", "b");
    assert.deepEqual((await store.read("a"))?.blockedBy, []);
  } finally { store.close(); }
});

test("ready is queued, unheld, all blockers done, in position order and repository filtered", async () => {
  const { store } = await fixture();
  try {
    for (const id of ["a", "b", "c", "d", "e"]) await store.add({ id, title: id });
    await store.add({ id: "other", title: "Other", repo: "other" });
    await store.block("a", "c");
    await store.block("a", "d");
    await store.hold("b", "Waiting");
    await start(store, "e");
    assert.deepEqual(await store.ready(), ["c", "d"]);
    await assert.rejects(start(store, "a"), { reason: "not_ready" });
    await assert.rejects(start(store, "b"), { reason: "not_ready" });
    await store.done("c");
    assert.deepEqual(await store.ready(), ["d"]);
    await store.done("d");
    assert.deepEqual(await store.ready(), ["a"]);
    const { attempts, ref } = await start(store, "a");
    await store.reopen("c");
    assert.equal((await store.read("a"))?.state, "in_flight");
    await attempts.recordOutcome(ref, { outcome: "done", reason: "Outcome after its blocker was reopened", category: "done" });
    assert.equal((await store.read("a"))?.state, "done");
    await store.reopen("a");
    assert.deepEqual(await store.ready(), ["c"]);
    await store.release("b");
    assert.deepEqual(await store.ready(), ["b", "c"]);
  } finally { store.close(); }
});

test("transactions roll back failed changes", async () => {
  const { store } = await fixture();
  try {
    await store.add({ id: "a", title: "A" });
    await assert.rejects(store.database.transaction(() => {
      store.database.run("UPDATE tasks SET title = 'Wrong' WHERE id = 'a'");
      throw new Error("Abort");
    }), /Abort/);
    assert.equal((await store.read("a"))?.title, "A");
  } finally { store.close(); }
});

test("opening a version 2 database removes the body snapshot and preserves tasks, dependencies and attempts", async () => {
  const { store, path } = await fixture();
  await store.add({ id: "a", title: "A", body: "Original instructions" });
  await store.add({ id: "b", title: "B" });
  const { attempts, ref } = await start(store, "a");
  await store.update("a", { body: "Operator's newer instructions" });
  await store.block("a", "b");
  await store.hold("b", "Operator hold");
  const tasksBefore = (await store.list()).map(task => ({ ...task, definitionRevision: 1 }));
  const { specification: _specification, ...attemptBefore } = attempts.read(ref);
  await store.database.transaction(() => {
    store.database.run("ALTER TABLE tasks ADD COLUMN started_body TEXT");
    store.database.run("UPDATE tasks SET started_body = 'Original instructions' WHERE id = 'a'");
    for (const table of ["review_tasks", "request_records", "attempt_specifications", "control_requests", "worker_activity", "worker_observations", "launches", "worker_claims"]) store.database.run(`DROP TABLE ${table}`);
    store.database.run("DROP INDEX worker_stop_per_attempt");
    store.database.run("ALTER TABLE confirmations DROP COLUMN note");
    store.database.run("DROP TRIGGER task_definition_changed");
    store.database.run("ALTER TABLE tasks DROP COLUMN acceptance_criteria");
    store.database.run("ALTER TABLE tasks DROP COLUMN definition_revision");
    store.database.run("PRAGMA user_version = 2");
  });
  store.close();
  const reopened = await Promise.all([SqliteTaskStore.open({ path }), SqliteTaskStore.open({ path })]);
  try {
    for (const current of reopened) {
      assert.equal(current.database.get("PRAGMA user_version")!.user_version, 9);
      assert.ok(current.database.all("PRAGMA table_info(tasks)").every(column => column.name !== "started_body"));
      assert.deepEqual(await current.list(), tasksBefore);
      assert.deepEqual(new AttemptStore(current.database, "fixture").read(ref), attemptBefore);
      assert.deepEqual(current.database.all("PRAGMA foreign_key_check"), []);
    }
    const current = reopened[0]!;
    await new AttemptStore(current.database, "fixture").recordOutcome(ref, { outcome: "hold", reason: "Review", category: "review_required" });
    assert.partialDeepStrictEqual(await current.read("a"), { state: "queued", held: true, body: "Operator's newer instructions" });
  } finally { for (const current of reopened) current.close(); }
});

test("definition revisions change atomically with the definition, not readiness or state", async () => {
  const { store } = await fixture();
  try {
    await store.add({ id: "a", title: "A", body: "Instructions" });
    await store.add({ id: "b", title: "B" });
    let revision = 1;
    const currentRevision = async () => (await store.read("a"))!.definitionRevision;
    assert.equal(await currentRevision(), revision);
    for (const changes of [{ title: "New title" }, { body: "New instructions" }, { repo: "other" }, { kind: "scout" }]) {
      await store.update("a", changes);
      assert.equal(await currentRevision(), ++revision);
      await store.update("a", changes);
      assert.equal(await currentRevision(), revision, "No-op updates do not change the revision");
    }
    await store.update("a", { title: "All fields", body: "All instructions", repo: "fixture", kind: "task" });
    assert.equal(await currentRevision(), ++revision);
    for (const change of [() => store.hold("a", "Held"), () => store.release("a"), () => store.block("a", "b"),
      () => store.unblock("a", "b"), () => store.done("a"), () => store.reopen("a")]) {
      await change();
      assert.equal(await currentRevision(), revision);
    }
    await assert.rejects(store.database.transaction(() => {
      store.database.run("UPDATE tasks SET title = 'Rolled back' WHERE id = 'a'");
      assert.equal(store.database.get("SELECT definition_revision FROM tasks WHERE id = 'a'")!.definition_revision, revision + 1);
      throw new Error("Rollback");
    }), /Rollback/);
    assert.equal(await currentRevision(), revision);
    assert.equal((await store.read("a"))!.title, "All fields");
  } finally { store.close(); }
});

test("database durability, schema version, absolute canonical regular paths", async () => {
  const { store, dir, path } = await fixture();
  assert.equal(store.database.get("PRAGMA journal_mode")?.journal_mode, "wal");
  assert.equal(store.database.get("PRAGMA synchronous")?.synchronous, 2);
  assert.equal(store.database.get("PRAGMA fullfsync")?.fullfsync, 1);
  assert.equal(store.database.get("PRAGMA busy_timeout")?.timeout, 0);
  assert.equal(store.database.get("PRAGMA user_version")?.user_version, 9);
  store.close();
  await assert.rejects(SqliteTaskStore.open({ path: "relative.db" }), /absolute/);
  await assert.rejects(SqliteTaskStore.open({ path: dir }), /regular file/);
  await symlink(path, join(dir, "link.db"));
  await assert.rejects(SqliteTaskStore.open({ path: join(dir, "link.db") }), /link/);
});
