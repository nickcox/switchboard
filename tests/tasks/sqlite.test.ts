import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SqliteTaskStore } from "../../src/tasks/sqlite.ts";
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
    await store.start("a");
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
    await store.start("e");
    assert.deepEqual(await store.ready(), ["c", "d"]);
    await assert.rejects(store.start("a"), rejected);
    await assert.rejects(store.start("b"), rejected);
    await store.done("c");
    assert.deepEqual(await store.ready(), ["d"]);
    await store.done("d");
    assert.deepEqual(await store.ready(), ["a"]);
    await store.start("a");
    await store.reopen("c");
    assert.equal((await store.read("a"))?.state, "in_flight");
    await store.recordDone("a", "Outcome after its blocker was reopened");
    assert.equal((await store.read("a"))?.state, "done");
    await store.reopen("a");
    assert.deepEqual(await store.ready(), ["c"]);
    await store.release("b");
    assert.deepEqual(await store.ready(), ["b", "c"]);
  } finally { store.close(); }
});

test("outcomes preserve newer operator decisions, including hold followed by release", async () => {
  const { store } = await fixture();
  try {
    for (const id of ["done", "held", "released", "reopened", "normal"]) {
      await store.add({ id, title: id, body: "Original" });
      await store.start(id);
    }
    await store.done("done", "Operator decision");
    await store.hold("held", "Operator hold");
    await store.hold("released", "Temporary");
    await store.release("released");
    await store.reopen("reopened");
    for (const id of ["done", "held", "released", "reopened"]) {
      const before = await store.read(id);
      await store.recordDone(id, "Outcome");
      await store.recordHold(id, { reason: "Outcome", body: "Replacement" });
      assert.deepEqual(await store.read(id), before);
    }
    await store.update("normal", { body: "New instructions" });
    await store.recordHold("normal", { reason: "Review", body: "Original\n\nRetained outcome" });
    assert.partialDeepStrictEqual(await store.read("normal"), { state: "queued", held: true, body: "New instructions\n\nRetained outcome" });
  } finally { store.close(); }
});

test("finalisation compares expected state atomically; transactions roll back failed changes", async () => {
  const { store } = await fixture();
  try {
    await store.add({ id: "a", title: "A" });
    const expected = (await store.read("a"))!;
    await store.hold("a", "New decision");
    await assert.rejects(store.recordDone("a", "Finish", expected), rejected);
    assert.equal((await store.read("a"))?.state, "queued");
    await assert.rejects(store.database.transaction(() => {
      store.database.run("UPDATE tasks SET title = 'Wrong' WHERE id = 'a'");
      throw new Error("Abort");
    }), /Abort/);
    assert.equal((await store.read("a"))?.title, "A");
    const held = (await store.read("a"))!;
    await store.hold("a", "New decision");
    await assert.rejects(store.recordHold("a", { reason: "Discard", body: "Outcome" }, held), rejected);
    const now = (await store.read("a"))!;
    assert.equal((await store.recordDone("a", "Finish", now)).state, "done");
  } finally { store.close(); }
});

test("database durability, schema version, absolute canonical regular paths", async () => {
  const { store, dir, path } = await fixture();
  assert.equal(store.database.get("PRAGMA journal_mode")?.journal_mode, "wal");
  assert.equal(store.database.get("PRAGMA synchronous")?.synchronous, 2);
  assert.equal(store.database.get("PRAGMA fullfsync")?.fullfsync, 1);
  assert.equal(store.database.get("PRAGMA busy_timeout")?.timeout, 0);
  assert.equal(store.database.get("PRAGMA user_version")?.user_version, 2);
  store.close();
  await assert.rejects(SqliteTaskStore.open({ path: "relative.db" }), /absolute/);
  await assert.rejects(SqliteTaskStore.open({ path: dir }), /regular file/);
  await symlink(path, join(dir, "link.db"));
  await assert.rejects(SqliteTaskStore.open({ path: join(dir, "link.db") }), /link/);
});
