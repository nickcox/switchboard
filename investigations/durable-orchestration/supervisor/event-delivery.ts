import type { ContextView, Conversation, HarnessInspection, SubmissionId, SubmissionRecord } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AttemptEntry, AttemptRef } from "../../../src/attempts/log.ts";
import type { ApplicationStore } from "../design-a/store.ts";

export const deliveryPoints = ["before_submit", "after_submit", "after_cursor", "queued"] as const;
export type DeliveryPoint = typeof deliveryPoints[number];
export type EventConfig = { objectiveId: string; source: AttemptRef; point: DeliveryPoint; failure: "none" | "initial" | "event" };
export type DeliveryEvent = { id: string; entry: AttemptEntry };
export type DeliverySnapshot = { conversationId: number; position: number;
  events: (DeliveryEvent & { submission: SubmissionRecord | null })[]; initial: SubmissionRecord | null;
  inbox: readonly { id: number; mode: string }[]; transcript: ContextView; engine: HarnessInspection;
};
export type DeliveryEvidence = { before: DeliverySnapshot; queued: DeliverySnapshot; afterFailure: DeliverySnapshot | null;
  final: DeliverySnapshot; wake: SubmissionRecord | null; deliveryCalls: { point: string; eventId: string; submissionId: number | null }[];
};
export const initialInput = { type: "input", content: "Wait for the attempt events.", requestId: "objective-input-1" } as const;
export const wakeInput = { type: "input", content: "Inspect and continue the queued inputs after the failed run.", requestId: "operator-wake-1" } as const;

// One fixed attempt is the source for this disposable trial. It does not define cross-attempt
// ordering, retention, recipient selection or a production event queue.
export class EventDelivery {
  readonly store: ApplicationStore;
  readonly config: EventConfig;
  constructor(store: ApplicationStore, config: EventConfig) { this.store = store; this.config = config; }

  async initialise(): Promise<void> {
    const db = this.store.tasks.database;
    await db.transaction(() => {
      db.run(`CREATE TABLE IF NOT EXISTS prototype_supervisor_delivery (
        objective TEXT PRIMARY KEY, position INTEGER NOT NULL CHECK(position >= -1))`);
      db.run("INSERT INTO prototype_supervisor_delivery VALUES(?, -1) ON CONFLICT DO NOTHING", this.config.objectiveId);
    });
  }

  events(): DeliveryEvent[] {
    return this.store.attempts.read(this.config.source).entries.map(entry => ({
      id: `event:${JSON.stringify([this.config.objectiveId, entry.contextId, entry.taskId, entry.attempt, entry.sequence])}`,
      entry,
    }));
  }

  position(): number {
    return Number(this.store.tasks.database.get("SELECT position FROM prototype_supervisor_delivery WHERE objective = ?", this.config.objectiveId)!.position);
  }

  async deliver(conversation: Conversation,
    boundary: (point: Exclude<DeliveryPoint, "queued">, event: DeliveryEvent, submissionId?: SubmissionId) => Promise<void>,
  ): Promise<void> {
    for (const event of this.events().filter(event => event.entry.sequence > this.position())) {
      await boundary("before_submit", event);
      // Admission is outside the application transaction. Same immutable source identity/content
      // after lost acknowledgement, whether this returns a new or an existing submission.
      const submission = await conversation.submit({ type: "input", requestId: event.id, content: JSON.stringify(event), whenBusy: "followUp" }, BACKGROUND_CONTEXT);
      await boundary("after_submit", event, submission.id);
      await this.store.tasks.database.transaction(() => {
        if (this.position() !== event.entry.sequence - 1) throw new Error("Delivery cursor is not at the preceding source entry");
        this.store.tasks.database.run("UPDATE prototype_supervisor_delivery SET position = ? WHERE objective = ?", event.entry.sequence, this.config.objectiveId);
      });
      await boundary("after_cursor", event, submission.id);
    }
  }
}
