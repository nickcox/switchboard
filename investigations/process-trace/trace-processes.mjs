// Records every child process started by this Node process, and by child Node processes through NODE_OPTIONS.
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
import { syncBuiltinESMExports } from "node:module";

const file = process.env.TRACE_PROCESSES_FILE;
const label = (command, args) => {
  const program = basename(String(command)).replace(/\.exe$/i, "");
  const list = Array.isArray(args) ? args : [];
  if (program === "node") return `node ${basename(String(list.find(a => !String(a).startsWith("-")) ?? "-e"))}`;
  if (program === "git") return `git ${list.find(a => !String(a).startsWith("-") && !String(a).includes("=")) ?? ""}`;
  if (program === "treehouse") return `treehouse ${list[0] ?? ""}`;
  return program;
};
const record = (name, started) => {
  if (file) appendFileSync(file, `${JSON.stringify({ name, ms: Number(process.hrtime.bigint() - started) / 1e6, pid: process.pid })}\n`);
};
const argsOf = (args) => Array.isArray(args) ? args : [];

for (const method of ["spawn", "execFile"]) {
  const original = childProcess[method];
  childProcess[method] = function (command, args, ...rest) {
    const started = process.hrtime.bigint();
    const child = original.call(this, command, args, ...rest);
    const name = label(command, argsOf(args));
    child.once("exit", () => record(name, started));
    return child;
  };
}
for (const method of ["spawnSync", "execFileSync"]) {
  const original = childProcess[method];
  childProcess[method] = function (command, args, ...rest) {
    const started = process.hrtime.bigint();
    try { return original.call(this, command, args, ...rest); }
    finally { record(label(command, argsOf(args)), started); }
  };
}
syncBuiltinESMExports();
