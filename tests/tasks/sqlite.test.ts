import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SqliteTaskStore } from "../../src/tasks/sqlite.ts";
import { AttemptStore } from "../../src/attempts/store.ts";
import { TaskStoreError } from "../../src/tasks/store.ts";

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
  const { ref } = await attempts.reserveAttempt({ taskId: id, requested: {}, maximum: 100 });
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
  const tasksBefore = await store.list();
  const attemptBefore = attempts.read(ref);
  await store.database.transaction(() => {
    store.database.run("ALTER TABLE tasks ADD COLUMN started_body TEXT");
    store.database.run("UPDATE tasks SET started_body = 'Original instructions' WHERE id = 'a'");
    store.database.run("PRAGMA user_version = 2");
  });
  store.close();
  const reopened = await Promise.all([SqliteTaskStore.open({ path }), SqliteTaskStore.open({ path })]);
  try {
    for (const current of reopened) {
      assert.equal(current.database.get("PRAGMA user_version")!.user_version, 3);
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

test("database durability, schema version, absolute canonical regular paths", async () => {
  const { store, dir, path } = await fixture();
  assert.equal(store.database.get("PRAGMA journal_mode")?.journal_mode, "wal");
  assert.equal(store.database.get("PRAGMA synchronous")?.synchronous, 2);
  assert.equal(store.database.get("PRAGMA fullfsync")?.fullfsync, 1);
  assert.equal(store.database.get("PRAGMA busy_timeout")?.timeout, 0);
  assert.equal(store.database.get("PRAGMA user_version")?.user_version, 3);
  store.close();
  await assert.rejects(SqliteTaskStore.open({ path: "relative.db" }), /absolute/);
  await assert.rejects(SqliteTaskStore.open({ path: dir }), /regular file/);
  await symlink(path, join(dir, "link.db"));
  await assert.rejects(SqliteTaskStore.open({ path: join(dir, "link.db") }), /link/);
});
