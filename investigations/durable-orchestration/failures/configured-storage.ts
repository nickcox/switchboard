import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { NodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { SqliteStorage, type SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";

export const fullSettings = { journal_mode: "wal", synchronous: 2, fullfsync: 1, checkpoint_fullfsync: 1 };

async function settings(connection: SqliteExecutor) {
  return Object.fromEntries(await Promise.all(Object.keys(fullSettings).map(async key =>
    [key, Object.values((await connection.get(`PRAGMA ${key}`))!)[0]])));
}

// This facade owns the caller's connection. Measure inside the very transaction used by Durable,
// including schema migration and commits, not on a second connection to the same file.
class MeasuredDatabase extends NodeSqliteDatabase {
  private readonly log: string;
  constructor(connection: DatabaseSync, log: string) { super(connection); this.log = log; }
  override transaction<T>(action: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return super.transaction(async transaction => {
      const live = await settings(transaction);
      assert.deepEqual(live, fullSettings);
      await appendFile(this.log, `${JSON.stringify({ pid: process.pid, settings: live })}\n`, { flush: true });
      return action(transaction);
    });
  }
}

export async function openConfiguredStorage(path: string, log: string): Promise<SqliteStorage> {
  const connection = new DatabaseSync(path);
  const database = new MeasuredDatabase(connection, log);
  try {
    await database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA fullfsync = ON; PRAGMA checkpoint_fullfsync = ON");
    return await SqliteStorage.open(database);
  } catch (error) { await database.close(); throw error; }
}
