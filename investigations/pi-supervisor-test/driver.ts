// Runs Pi in RPC mode with only the test extension's tools, sends one prompt, and stops once the extension's
// idle event has been answered (DONE-1) or after three minutes. Usage, from the repository root:
//   node investigations/pi-supervisor-test/driver.ts <pi cli.js> <output directory> [provider] [model]
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const [entrypoint, outputArg, provider = "openai-codex", model = "gpt-6.1-sol"] = process.argv.slice(2);
if (!entrypoint || !outputArg) throw new Error("Usage: driver.ts <pi cli.js> <output directory> [provider] [model]");
const output = resolve(outputArg);
mkdirSync(join(output, "sessions"), { recursive: true });
const extensionLog = join(output, "extension.jsonl");
const rpcLog = join(output, "rpc.jsonl");

const child = spawn(process.execPath, [entrypoint, "--mode", "rpc",
  "--extension", resolve(import.meta.dirname, "extension.ts"), "--tools", "sb_status,sb_slow",
  "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp",
  "--provider", provider, "--model", model, "--thinking", "low", "--session-dir", join(output, "sessions"),
], { cwd: output, env: { ...process.env, PI_TEST_LOG: extensionLog, PI_SKIP_VERSION_CHECK: "1" }, stdio: ["pipe", "pipe", "pipe"] });

const lines = createInterface({ input: child.stdout });
lines.on("line", line => {
  appendFileSync(rpcLog, `${line}\n`);
  try {
    const message = JSON.parse(line);
    if (message.type === "message_end" && message.message?.role === "assistant") {
      const text = (message.message.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join(" ");
      const tools = (message.message.content ?? []).filter((c: { type: string }) => c.type === "toolCall").map((c: { name: string }) => c.name);
      console.log(`assistant: ${text.slice(0, 120)}${tools.length ? ` [tools: ${tools.join(", ")}]` : ""}`);
    }
  } catch { /* not JSON */ }
});
child.stderr.on("data", chunk => appendFileSync(join(output, "stderr.log"), chunk));

const prompt = [
  "This is a short test. You have only the tools you can see.",
  "First, say whether you have any shell, bash, file-editing or file-writing tool: answer HAS_SHELL or NO_SHELL, listing your tool names.",
  "Then call sb_slow once. When it finishes, reply READY.",
  "Later messages starting with EVENT will tell you what to do.",
].join(" ");
child.stdin.write(`${JSON.stringify({ id: "prompt-1", type: "prompt", message: prompt })}\n`);

const deadline = Date.now() + 180_000;
const timer = setInterval(() => {
  let done = false;
  // Look for the assistant's reply, not the event text that asks for it.
  try { done = readFileSync(rpcLog, "utf8").split("\n").some(line => line.includes('"type":"message_end"') && line.includes('"role":"assistant"') && line.includes("DONE-1")); } catch { /* no output yet */ }
  if (done || Date.now() > deadline) {
    clearInterval(timer);
    console.log(done ? "finished: DONE-1 seen" : "stopped: three-minute limit");
    // Give the extension a heartbeat or two after the last turn, then stop Pi.
    setTimeout(() => { child.stdin.end(); setTimeout(() => child.kill("SIGTERM"), 3000); }, 4500);
  }
}, 1000);
child.on("exit", code => console.log(`pi exited: ${code}`));
