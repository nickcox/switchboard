import { createAssistantMessageEventStream, type AssistantMessage, type Models } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ApplicationStore } from "../design-a/store.ts";

export type TrialLimits = { maxRequests: number; maxDurationMs: number; maxInputBytes: number; maxOutputTokens: number | null;
  maxObservedTokens: number; maxObservedCostUsd: number };

// Model-call admission/accounting, not an attempt workflow or a provider billing guarantee.
// A request interrupted before settlement remains unknown and blocks further calls.
export async function budgetedModels(base: Models, store: ApplicationStore, identity: string, limits: TrialLimits, expiresAt: number): Promise<Models> {
  const db = store.tasks.database;
  await db.transaction(() => {
    db.run("CREATE TABLE IF NOT EXISTS prototype_trial_identity (id INTEGER PRIMARY KEY CHECK(id = 1), identity TEXT NOT NULL)");
    db.run(`CREATE TABLE IF NOT EXISTS prototype_trial_requests (id INTEGER PRIMARY KEY, started INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','settled','unknown')), tokens REAL, cost REAL)`);
    db.run("INSERT INTO prototype_trial_identity VALUES(1, ?) ON CONFLICT DO NOTHING", identity);
    if (db.get("SELECT identity FROM prototype_trial_identity")!.identity !== identity) throw new Error("Trial profile changed; use a new fixture, not reset accounting");
  });
  const streamSimple: Models["streamSimple"] = (model, input, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      let requestId: number | undefined;
      try {
        const started = await db.transaction(() => {
          const requests = db.all("SELECT * FROM prototype_trial_requests");
          const now = Date.now();
          if (now >= expiresAt) throw new Error("Trial authorisation expired");
          if (requests.some(request => request.status !== "settled")) throw new Error("Unsettled model usage requires operator reconciliation, not automatic retry");
          if (requests.length >= limits.maxRequests) throw new Error("Trial request limit reached");
          if (requests.reduce((n, request) => n + Number(request.tokens), 0) >= limits.maxObservedTokens ||
            requests.reduce((n, request) => n + Number(request.cost), 0) >= limits.maxObservedCostUsd) throw new Error("Trial observed usage limit reached");
          const first = requests[0] ? Number(requests[0].started) : now;
          const remaining = Math.min(first + limits.maxDurationMs, expiresAt) - now;
          if (remaining <= 0) throw new Error("Trial duration limit reached");
          if (Buffer.byteLength(JSON.stringify(input)) > limits.maxInputBytes) throw new Error("Trial input byte limit reached");
          const id = Number(db.run("INSERT INTO prototype_trial_requests(started,status) VALUES(?,'pending')", now).lastInsertRowid);
          return { id, remaining };
        });
        requestId = started.id;
        const signal = AbortSignal.any([AbortSignal.timeout(started.remaining), ...(options?.signal ? [options.signal] : [])]);
        const { maxTokens: _unapprovedOutputLimit, ...requestOptions } = options ?? {};
        const source = base.streamSimple(model, input, { ...requestOptions, signal,
          ...(limits.maxOutputTokens === null ? {} : { maxTokens: limits.maxOutputTokens }), maxRetries: 0, deferred: false, transport: "sse", timeoutMs: started.remaining });
        for await (const event of source) {
          if (event.type !== "done" && event.type !== "error") { stream.push(event); continue; }
          let message = event.type === "done" ? event.message : event.error;
          const tokens = message.usage.totalTokens;
          const cost = message.usage.cost.total;
          const known = event.type === "done" && Number.isFinite(tokens) && tokens >= 0 && Number.isFinite(cost) && cost >= 0;
          const exceeded = await db.transaction(() => {
            db.run("UPDATE prototype_trial_requests SET status=?,tokens=?,cost=? WHERE id=?",
              known ? "settled" : "unknown", known ? tokens : null, known ? cost : null, requestId!);
            const total = db.get("SELECT sum(tokens) AS tokens, sum(cost) AS cost FROM prototype_trial_requests")!;
            return Number(total.tokens) >= limits.maxObservedTokens || Number(total.cost) >= limits.maxObservedCostUsd;
          });
          // Do not execute tool calls from a response that reached a configured stop threshold.
          if (exceeded) message = { ...message, stopReason: "error", errorMessage: "Trial observed usage limit reached" };
          if (message.stopReason === "error" || message.stopReason === "aborted") stream.push({ type: "error", reason: message.stopReason, error: message });
          else stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
          stream.end(message);
          return;
        }
        throw new Error("Provider stream ended without a terminal result");
      } catch (error) {
        if (requestId !== undefined) await db.transaction(() => {
          db.run("UPDATE prototype_trial_requests SET status='unknown' WHERE id=? AND status='pending'", requestId!);
        }).catch(() => {});
        const message: AssistantMessage = { ...fauxAssistantMessage(""), provider: model.provider, model: model.id, api: model.api,
          stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error) };
        stream.push({ type: "error", reason: "error", error: message });
        stream.end(message);
      }
    })();
    return stream;
  };
  // Models has prototype methods/private state. Forward and bind its public API rather
  // than spreading an instance, which would silently drop those methods.
  return new Proxy(base, { get(target, key) {
    if (key === "streamSimple") return streamSimple;
    if (["stream", "complete", "completeSimple", "streamDeferred", "fetchDeferred", "cancelDeferred", "generateImages", "classify", "refresh", "login"].includes(String(key))) {
      return () => { throw new Error("Trial permits only budgeted streamSimple calls"); };
    }
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
