// Synthetic RPC peer only. No Pi agent or model is created.
import { execFileSync } from "node:child_process";
import { appendFileSync, symlinkSync, writeFileSync } from "node:fs";
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
let binding: RuntimeBinding;
let questionDelivered = false;
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
    criteriaReport: binding.input.acceptanceCriteria.map((criterion: string, index: number) => ({
      position: index + 1, criterion, status: "met", evidence: "Synthetic fixture evidence",
    })),
    validationEvidence: [{ name: "tests", summary: "Fixture checks passed" }],
    workReferences: [{ kind: "git", name: "code", branch: binding.input.delivery.outputBranch, commit: "b".repeat(40) }],
  };
  if (scenario?.startsWith("review-")) {
    const target = binding.input.reviewTarget!;
    const report = join(binding.artefactDirectory!, "report.md");
    writeFileSync(report, "# Synthetic review\n");
    if (scenario === "review-fail") result.criteriaReport[0]!.status = "not_met";
    writeFileSync(binding.resultPath, JSON.stringify({
      ...result, workReferences: [
        { kind: "git", name: "reviewed-output", branch: target.outputBranch, commit: scenario === "review-wrong-commit" ? "c".repeat(40) : target.commit },
        { kind: "artefact", name: "report", path: report, description: "Synthetic review findings" },
      ],
    }));
    return;
  }
  if (scenario === "missing-result") return;
  if (scenario === "missing-criteria") result.criteriaReport = [];
  if (scenario === "duplicate-criteria") result.criteriaReport = [result.criteriaReport[0]!, result.criteriaReport[0]!];
  if (scenario === "extra-criteria") result.criteriaReport.push({ position: result.criteriaReport.length + 1, criterion: "Extra criterion", status: "met", evidence: "Claim" });
  if (scenario === "artefact-result" || scenario === "artefact-in-workspace") {
    // A report deliverable: written to the attempt's artefact directory, or wrongly left in the workspace.
    const directory = scenario === "artefact-result" ? binding.artefactDirectory! : process.cwd();
    const report = join(directory, "report.md");
    writeFileSync(report, "# Synthetic report\n");
    writeFileSync(binding.resultPath, JSON.stringify({
      ...result, workReferences: [{ kind: "artefact", name: "report", path: report, description: "Synthetic investigation report" }],
    }));
    return;
  }
  if (scenario === "commit-result" || scenario === "questions-finish") {
    // Makes a real commit on the output branch in the workspace, so retention checks can pass.
    writeFileSync(join(process.cwd(), "worker-output.txt"), `synthetic worker output on ${binding.input.delivery.outputBranch}\n`);
    const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim();
    git(["add", "worker-output.txt"]);
    git(["commit", "-q", "--no-gpg-sign", "-m", "Synthetic worker output"]);
    result.workReferences[0]!.commit = git(["rev-parse", "HEAD"]);
  }
  if (scenario === "no-new-commit") result.workReferences[0]!.commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
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
      thinkingLevel: scenario === "wrong-thinking" ? "low" : process.argv.includes("--thinking") ? flag("--thinking") : "medium",
      sessionId: scenario === "wrong-session" ? "wrong-session" : sessionId,
      sessionFile: join(sessions, `fixture_${sessionId}.jsonl`),
      isStreaming: scenario === "await-question" && binding !== undefined && !questionDelivered,
      isCompacting: false, pendingMessageCount: 0,
    });
  } else if (request.type === "prompt") {
    const input = JSON.parse(String(request.message).split("Use this instruction snapshot and resolved delivery contract unchanged:\n\n")[1]!.split("\n\nBefore your final response")[0]!);
    binding = { version: 1, createdAt: new Date().toISOString(), input, sessionDirectory: sessions,
      resultPath: join(dirname(sessions), "result.json"), artefactDirectory: join(dirname(sessions), "artefacts") };
    if (scenario === "bad-json") { process.stdout.write("not json\n"); return; }
    if (scenario === "wrong-response") {
      send({ type: "response", id: request.id, command: "other", success: true }); return;
    }
    if (scenario === "handled") { respond(request, { disposition: "handled" }); return; }
    reportResult();
    if (scenario?.startsWith("await-question") || scenario === "questions-finish") {
      writeFileSync(join(binding.input.questionsDirectory!, "design.question.json"), JSON.stringify({
        text: "Which design should I use?", choices: ["Small", "Large"], waiting: true,
      }));
      if (scenario === "questions-finish") writeFileSync(join(binding.input.questionsDirectory!, "later.question.json"), JSON.stringify({
        text: "Should the next attempt update the guide?", waiting: false,
      }));
    }
    if (scenario === "idle-only") {
      respond(request, { disposition: "started" });
      send({ type: "agent_settled", aborted: false }); return;
    }
    send({ type: "agent_start" });
    if (scenario !== "no-ack" && scenario !== "fast-events") respond(request, { disposition: "started" });
    if (scenario === "await-question-settled") setTimeout(() => {
      send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Finished before the answer" }], stopReason: "stop" } });
      send({ type: "agent_settled", aborted: false });
      writeFileSync(join(dirname(sessions), "fixture-settled"), "settled");
    }, 300);
    if (scenario === "ignore-stop" || scenario?.startsWith("await-steer") || scenario?.startsWith("await-question")) return;
    send({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "echo synthetic" } });
    send({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: {}, isError: false, durationMs: 12 });
    send({ type: "message_end", message: {
      role: "assistant", content: [{ type: "text", text: "Synthetic worker finished" }],
      stopReason: scenario?.startsWith("model-error") ? "error" : scenario === "model-length" ? "length" : "stop",
      ...(scenario === "model-error" ? { errorMessage: "WebSocket error" } : {}),
      ...(scenario === "model-error-long" ? { errorMessage: `WebSocket error\n${"connection dropped ".repeat(100)}` } : {}),
    } });
    send({ type: "agent_settled", aborted: false });
    if (scenario === "fast-events") respond(request, { disposition: "started" });
    if (scenario === "trailing-json") process.stdout.write('{"type":');
    if (scenario === "nonzero-exit") process.exit(9);
  } else if ((request.type === "steer" || request.type === "follow_up") && scenario?.startsWith("await-question")) {
    questionDelivered = true;
    respond(request, { disposition: "queued" });
    send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `Received: ${String(request.message)}` }], stopReason: "stop" } });
    send({ type: "agent_settled", aborted: false });
  } else if (request.type === "follow_up" && scenario === "await-steer-slow") {
    // Answer a follow-up only after a delay, so it is still being forwarded while the worker finishes.
    setTimeout(() => respond(request, { disposition: "queued" }), 300);
  } else if ((request.type === "steer" || request.type === "follow_up") && scenario?.startsWith("await-steer")) {
    // Finish the run only once a message arrives, to show it reached the running worker.
    respond(request, { disposition: "queued" });
    send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `Received: ${String(request.message)}` }], stopReason: "stop" } });
    send({ type: "agent_settled", aborted: false });
  } else if (request.type === "get_session_stats") {
    const data = { tokens: { total: 1200 }, cost: scenario === "expensive" ? 9.99 : scenario === "free" ? 0 : 0.01 };
    if (scenario === "await-question-settled") setTimeout(() => respond(request, data), 700);
    else respond(request, data);
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
