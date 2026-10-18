// Synthetic RPC peer only. No Pi agent or model is created.
import { appendFileSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { RuntimeBinding } from "../../src/runtime/records.ts";

function flag(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || !value) throw new Error(`Missing ${name}`);
  return value;
}
const scenario = process.env.FAKE_PI_SCENARIO;
const sessionId = flag("--session-id");
const sessions = flag("--session-dir");
const binding = JSON.parse(readFileSync(join(dirname(sessions), "binding.json"), "utf8")) as RuntimeBinding;
writeFileSync(join(dirname(sessions), "fixture-launch.json"), JSON.stringify({ argv: process.argv, cwd: process.cwd() }));
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
function respond(request: Record<string, unknown>, data?: unknown) {
  send({ type: "response", id: request.id, command: request.type, success: true, data });
}
if (scenario === "startup-settled") send({ type: "agent_settled", aborted: false });
let hold: ReturnType<typeof setInterval> | undefined;
if (scenario === "ignore-stop") {
  hold = setInterval(() => {}, 1000);
  process.on("SIGTERM", () => {});
}
if (scenario === "startup-exit") process.exit(1);

function reportResult() {
  const result = {
    version: 1, identity: binding.input.identity, outcome: "completed",
    summary: "Synthetic worker completion, not a model run",
    validationEvidence: [{ name: "tests", summary: "Fixture checks passed" }],
    workReferences: [{ kind: "git", name: "code", branch: binding.input.delivery.outputBranch, commit: "b".repeat(40) }],
  };
  if (scenario === "missing-result") return;
  if (scenario === "hold" || scenario === "failed") {
    writeFileSync(binding.resultPath, JSON.stringify({
      ...result, outcome: scenario, reason: "Needs operator inspection", nextAction: "Inspect retained workspace",
      validationEvidence: [], workReferences: [],
    }));
    return;
  }
  if (scenario === "stale-result") result.identity = { ...result.identity, sessionId: "00000000-0000-4000-8000-000000000000" };
  if (scenario === "missing-evidence") result.validationEvidence = [];
  if (scenario === "wrong-branch") result.workReferences[0]!.branch = "another-branch";
  if (scenario === "malformed-result") { writeFileSync(binding.resultPath, "{partial"); return; }
  if (scenario === "large-result") { writeFileSync(binding.resultPath, " ".repeat(1024 * 1024 + 1)); return; }
  if (scenario === "symlink-result") {
    const other = join(dirname(binding.resultPath), "other.json");
    writeFileSync(other, JSON.stringify(result));
    symlinkSync(other, binding.resultPath);
    return;
  }
  writeFileSync(binding.resultPath, JSON.stringify(result));
}
function handle(request: Record<string, unknown>) {
  appendFileSync(process.env.FAKE_PI_LOG!, `${JSON.stringify(request)}\n`);
  if (request.type === "get_state") {
    respond(request, {
      model: { provider: "fixture", id: scenario === "wrong-model" ? "another-model" : "fixture" },
      sessionId: scenario === "wrong-session" ? "wrong-session" : sessionId,
      sessionFile: join(sessions, `fixture_${sessionId}.jsonl`),
      isStreaming: false, isCompacting: false, pendingMessageCount: 0,
    });
  } else if (request.type === "prompt") {
    if (scenario === "bad-json") { process.stdout.write("not json\n"); return; }
    if (scenario === "wrong-response") {
      send({ type: "response", id: request.id, command: "other", success: true }); return;
    }
    if (scenario === "handled") { respond(request, { disposition: "handled" }); return; }
    reportResult();
    if (scenario === "idle-only") {
      respond(request, { disposition: "started" });
      send({ type: "agent_settled", aborted: false }); return;
    }
    send({ type: "agent_start" });
    if (scenario !== "no-ack" && scenario !== "fast-events") respond(request, { disposition: "started" });
    if (scenario === "ignore-stop") return;
    send({ type: "message_end", message: { role: "assistant", stopReason: scenario === "model-error" ? "error" : "stop" } });
    send({ type: "agent_settled", aborted: false });
    if (scenario === "fast-events") respond(request, { disposition: "started" });
    if (scenario === "trailing-json") process.stdout.write('{"type":');
    if (scenario === "nonzero-exit") process.exit(9);
  } else if (request.type === "clear_queue") respond(request, { steering: [], followUp: [] });
  else if (request.type === "abort") {
    if (scenario !== "ignore-stop") respond(request);
  } else respond(request);
}

const decoder = new StringDecoder("utf8");
let buffered = "";
process.stdin.on("data", (bytes: Buffer) => {
  buffered += decoder.write(bytes);
  let boundary: number;
  while ((boundary = buffered.indexOf("\n")) !== -1) {
    const line = buffered.slice(0, boundary);
    buffered = buffered.slice(boundary + 1);
    handle(JSON.parse(line) as Record<string, unknown>);
  }
});
process.stdin.on("end", () => {
  if (scenario === "ignore-stop") return;
  if (hold) clearInterval(hold);
  if (scenario === "delay-exit") {
    writeFileSync(join(dirname(sessions), "fixture-eof"), "stdin closed");
    setTimeout(() => process.exit(0), 150);
  }
});
