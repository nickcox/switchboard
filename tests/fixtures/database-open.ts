import { writeSync } from "node:fs";
import { Database } from "../../src/database.ts";

// Opens the database, commits one task, and exits without closing it, as a crashed process would.
const [path, id] = process.argv.slice(2);
const db = await Database.open(path!);
await db.transaction(() => db.run("INSERT INTO tasks (id, title, body, position) VALUES (?, ?, '', (SELECT coalesce(max(position), 0) + 1 FROM tasks))", id!, id!));
writeSync(1, "committed\n");
process.exit(0);
