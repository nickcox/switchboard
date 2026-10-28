import { Database } from "../database.ts";
import { acceptanceCriteriaSchema, criteriaSection } from "./criteria.ts";
import { TaskStoreError, type Task, type TaskState, type TaskStore } from "./store.ts";

export type StoredTask = Task & { position: number; blockedBy: string[]; holdRevision: number };
export type NewTask = { id: string; title: string; body?: string; repo?: string | null; kind?: string | null; acceptanceCriteria?: string[] };
export type TaskChanges = Partial<Pick<Task, "title" | "body" | "repo" | "kind" | "acceptanceCriteria">>;
const reject = (message: string): never => { throw new TaskStoreError("rejected", message); };
const validCriteria = (criteria: string[]) => {
  if (!acceptanceCriteriaSchema.safeParse(criteria).success) reject("Each criterion must be a nonempty single line");
  return criteria;
};
const validReason = (reason: string) => {
  if (!reason || reason.length > 200 || /[\r\n]/.test(reason)) reject("Hold reason must be one line of 1–200 characters");
};

export class SqliteTaskStore implements TaskStore {
  readonly database: Database;
  readonly repo: string | null;
  private constructor(database: Database, repo: string | null) { this.database = database; this.repo = repo; }
  static async open(options: { path: string; repo?: string | null; retryMs?: number }): Promise<SqliteTaskStore> {
    return new SqliteTaskStore(await Database.open(options.path, options.retryMs), options.repo ?? null);
  }
  close() { this.database.close(); }
  async list(state?: TaskState): Promise<StoredTask[]> {
    return this.database.all("SELECT id FROM tasks WHERE (? IS NULL OR repo = ?) AND (? IS NULL OR state = ?) ORDER BY position", this.repo, this.repo, state ?? null, state ?? null)
      .map(row => this.require(String(row.id)));
  }
  async ready(): Promise<string[]> {
    return this.database.all(`SELECT t.id FROM tasks t WHERE t.state = 'queued' AND t.hold_reason IS NULL
      AND (? IS NULL OR t.repo = ?) AND NOT EXISTS (
        SELECT 1 FROM dependencies d JOIN tasks b ON b.id = d.blocker WHERE d.task = t.id AND b.state <> 'done')
      ORDER BY t.position`, this.repo, this.repo).map(row => String(row.id));
  }
  async inFlight(): Promise<string[]> { return (await this.list("in_flight")).map(task => task.id); }
  async read(id: string): Promise<StoredTask | undefined> { return this.readNow(id); }
  private readNow(id: string): StoredTask | undefined {
    const row = this.database.get(`SELECT *, EXISTS(SELECT 1 FROM dependencies d JOIN tasks b ON b.id = d.blocker
      WHERE d.task = tasks.id AND b.state <> 'done') AS blocked FROM tasks WHERE id = ?`, id);
    if (!row) return undefined;
    return {
      id: String(row.id), title: String(row.title), body: String(row.body), repo: row.repo as string | null,
      kind: row.kind as string | null, state: row.state as TaskState, definitionRevision: Number(row.definition_revision),
      acceptanceCriteria: acceptanceCriteriaSchema.parse(JSON.parse(String(row.acceptance_criteria))),
      held: row.hold_reason !== null,
      holdReason: row.hold_reason as string | null, blocked: Boolean(row.blocked), position: Number(row.position), holdRevision: Number(row.hold_revision),
      blockedBy: this.database.all("SELECT blocker FROM dependencies WHERE task = ? ORDER BY blocker", id).map(r => String(r.blocker)),
    };
  }
  private require(id: string): StoredTask { return this.readNow(id) ?? reject(`Task ${id} does not exist`); }
  async add(task: NewTask): Promise<StoredTask> {
    return this.database.transaction(() => {
      if (!/^[a-zA-Z0-9._-]+$/.test(task.id)) reject("Task ID must contain only letters, digits, ., _ and -");
      if (this.readNow(task.id)) reject(`Task ${task.id} already exists`);
      this.database.run(`INSERT INTO tasks(id,title,body,repo,kind,acceptance_criteria,position) VALUES(?,?,?,?,?,?,(SELECT coalesce(max(position),0)+1 FROM tasks))`,
        task.id, task.title, task.body ?? "", task.repo === undefined ? this.repo : task.repo || null, task.kind === "task" ? null : task.kind || null, JSON.stringify(validCriteria(task.acceptanceCriteria ?? [])));
      return this.require(task.id);
    });
  }
  async update(id: string, changes: TaskChanges): Promise<StoredTask> {
    return this.database.transaction(() => {
      this.require(id);
      if (changes.acceptanceCriteria !== undefined) validCriteria(changes.acceptanceCriteria);
      const fields = (["title", "body", "repo", "kind", "acceptanceCriteria"] as const).filter(key => changes[key] !== undefined);
      if (fields.length) this.database.run(`UPDATE tasks SET ${fields.map(key => `${key === "acceptanceCriteria" ? "acceptance_criteria" : key} = ?`).join(", ")} WHERE id = ?`,
        ...fields.map(key => key === "acceptanceCriteria" ? JSON.stringify(changes[key]) : key === "kind" && changes[key] === "task" ? null
          : (key === "repo" || key === "kind") && changes[key] === "" ? null : changes[key]!), id);
      return this.require(id);
    });
  }
  async convertCriteria(): Promise<{ id: string; status: "converted" | "unconverted"; reason?: string }[]> {
    return this.database.transaction(() => {
      const reports: { id: string; status: "converted" | "unconverted"; reason?: string }[] = [];
      for (const row of this.database.all("SELECT id FROM tasks WHERE (? IS NULL OR repo = ?) ORDER BY position", this.repo, this.repo)) {
        const task = this.require(String(row.id));
        const section = criteriaSection(task.body);
        if (!section) continue;
        const reason = task.state !== "queued" ? "Task is in flight or done"
          : task.acceptanceCriteria.length ? "Task already has stored criteria" : "reason" in section ? section.reason : undefined;
        if (reason) reports.push({ id: task.id, status: "unconverted", reason });
        else if ("body" in section) {
          this.database.run("UPDATE tasks SET body = ?, acceptance_criteria = ? WHERE id = ?", section.body, JSON.stringify(section.acceptanceCriteria), task.id);
          reports.push({ id: task.id, status: "converted" });
        }
      }
      return reports;
    });
  }
  async hold(id: string, reason: string): Promise<StoredTask> {
    validReason(reason);
    return this.change(id, () => this.database.run("UPDATE tasks SET hold_reason = ?, hold_revision = hold_revision + 1 WHERE id = ?", reason, id));
  }
  async release(id: string): Promise<StoredTask> {
    return this.change(id, () => this.database.run("UPDATE tasks SET hold_reason = NULL WHERE id = ?", id));
  }
  async block(id: string, by: string): Promise<StoredTask> {
    return this.change(id, () => {
      this.require(by);
      if (id === by || this.database.get(`WITH RECURSIVE blockers(id) AS (
        SELECT blocker FROM dependencies WHERE task = ? UNION SELECT d.blocker FROM dependencies d JOIN blockers b ON d.task = b.id)
        SELECT 1 FROM blockers WHERE id = ?`, by, id)) reject("Dependency would create a cycle");
      this.database.run("INSERT OR IGNORE INTO dependencies VALUES(?,?)", id, by);
    });
  }
  async unblock(id: string, by: string): Promise<StoredTask> {
    return this.change(id, () => this.database.run("DELETE FROM dependencies WHERE task = ? AND blocker = ?", id, by));
  }
  async done(id: string, note = ""): Promise<StoredTask> {
    return this.change(id, () => this.writeDone(id, note));
  }
  async reopen(id: string): Promise<StoredTask> {
    return this.change(id, () => this.database.run("UPDATE tasks SET state = 'queued' WHERE id = ?", id));
  }
  private writeDone(id: string, note: string) {
    const task = this.require(id);
    this.database.run("UPDATE tasks SET state = 'done', hold_reason = NULL, body = ? WHERE id = ?", note && !task.body.includes(note) ? `${task.body}\n\n${note}` : task.body, id);
  }
  private async change(id: string, apply: () => unknown): Promise<StoredTask> {
    return this.database.transaction(() => { this.require(id); apply(); return this.require(id); });
  }
}
