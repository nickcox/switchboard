import { open, readFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * Diagnostic record of what a worker is doing (Phase 1 PRD, watching and controlling a running attempt). Switchboard
 * never uses it to decide task, lease or liveness state; Pi's session file remains the full transcript.
 */
export const activityEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({ v: z.literal(1), ts: z.iso.datetime(), kind: z.literal("tool_start"), tool: z.string(), id: z.string(), args: z.string() }),
  z.strictObject({ v: z.literal(1), ts: z.iso.datetime(), kind: z.literal("tool_end"), tool: z.string(), id: z.string(), ms: z.number().nullable(), error: z.boolean() }),
  z.strictObject({ v: z.literal(1), ts: z.iso.datetime(), kind: z.literal("assistant"), text: z.string() }),
  z.strictObject({ v: z.literal(1), ts: z.iso.datetime(), kind: z.literal("queue"), steering: z.number(), followUp: z.number() }),
  z.strictObject({ v: z.literal(1), ts: z.iso.datetime(), kind: z.literal("stats"), tokens: z.number(), cost: z.number() }),
  z.strictObject({ v: z.literal(1), ts: z.iso.datetime(), kind: z.literal("note"), text: z.string() }),
]);
export type ActivityEntry = z.infer<typeof activityEntrySchema>;
export type Payload = ActivityEntry extends infer E ? E extends ActivityEntry ? Omit<E, "v" | "ts"> : never : never;

export const activityFile = "activity.jsonl";
const textLimit = 200;
const entryLimit = 2048;
export const activityFileLimit = 5 * 1024 * 1024;

export function shorten(text: string, limit = textLimit): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}

/** Appends entries in order. Write failures are swallowed: losing diagnostics must never affect the worker. */
export class ActivityWriter {
  private handle: Promise<FileHandle | undefined>;
  private chain: Promise<void> = Promise.resolve();
  private written = 0;
  private full = false;
  private readonly onEntry: ((entry: ActivityEntry) => void) | undefined;

  constructor(directory: string, onEntry?: (entry: ActivityEntry) => void) {
    this.handle = open(join(directory, activityFile), "a", 0o600).catch(() => undefined);
    this.onEntry = onEntry;
  }

  write(payload: Payload): void {
    if (this.full) return;
    const entry = activityEntrySchema.parse({ v: 1, ts: new Date().toISOString(), ...payload });
    let line = `${JSON.stringify(entry)}\n`;
    if (Buffer.byteLength(line) > entryLimit) line = `${JSON.stringify({ v: 1, ts: entry.ts, kind: "note", text: `${entry.kind} entry omitted: too large` })}\n`;
    if (this.written + Buffer.byteLength(line) > activityFileLimit) {
      this.full = true;
      line = `${JSON.stringify({ v: 1, ts: entry.ts, kind: "note", text: "Activity log size limit reached; later activity is not recorded" })}\n`;
    }
    this.written += Buffer.byteLength(line);
    this.onEntry?.(JSON.parse(line) as ActivityEntry);
    this.chain = this.chain.then(async () => {
      const handle = await this.handle;
      await handle?.appendFile(line).catch(() => {});
    });
  }

  async close(): Promise<void> {
    await this.chain;
    await (await this.handle)?.close().catch(() => {});
  }
}

/** Reads an attempt's activity entries, skipping lines that are partial or invalid. Missing means no activity yet. */
export async function readActivity(directory: string): Promise<ActivityEntry[]> {
  let text: string;
  try { text = await readFile(join(directory, activityFile), "utf8"); }
  catch { return []; }
  const entries: ActivityEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(activityEntrySchema.parse(JSON.parse(line))); } catch { /* A partial last line or foreign content. */ }
  }
  return entries;
}

export function describeEntry(entry: ActivityEntry): string {
  const time = entry.ts.slice(11, 19);
  switch (entry.kind) {
    case "tool_start": return `${time} ${entry.tool}: ${entry.args}`;
    case "tool_end": return `${time} ${entry.tool} ${entry.error ? "failed" : "done"}${entry.ms === null ? "" : ` (${(entry.ms / 1000).toFixed(1)}s)`}`;
    case "assistant": return `${time} says: ${entry.text}`;
    case "queue": return `${time} queue: ${entry.steering} steering, ${entry.followUp} follow-up`;
    case "stats": return `${time} usage: ${entry.tokens} tokens, $${entry.cost.toFixed(2)}`;
    case "note": return `${time} ${entry.text}`;
  }
}
