import { spawn } from "node:child_process";
import { z } from "zod";
import { runCommand } from "../infra/command.ts";
import { shorten } from "./activity.ts";

export const keepAwakeSchema = z.union([
  z.boolean(),
  z.strictObject({ command: z.tuple([z.string().trim().min(1)]).rest(z.string()) }),
]);
export type KeepAwake = z.output<typeof keepAwakeSchema>;

export function defaultKeepAwakeCommand(platform: NodeJS.Platform = process.platform): string[] | undefined {
  switch (platform) {
    case "darwin": return ["caffeinate", "-i", "-w", "{pid}"];
    case "linux": return [
      "systemd-inhibit", "--what=idle:sleep", "--why=Switchboard worker running", "--mode=block",
      process.execPath, "-e", "setInterval(() => { try { process.kill(Number(process.argv[1]), 0); } catch { process.exit(0); } }, 1000)", "{pid}",
    ];
    case "win32": return [
      "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class SwitchboardPower { [DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint flags); }'; if ([SwitchboardPower]::SetThreadExecutionState([uint32]2147483649) -eq 0) { throw 'SetThreadExecutionState failed' }; Wait-Process -Id {pid} -ErrorAction SilentlyContinue",
    ];
    default: return undefined;
  }
}

/** The command owns its power assertion; stopping it releases that assertion on every worker exit path. */
export async function startKeepAwake(setting: KeepAwake, note: (text: string) => void): Promise<() => Promise<void>> {
  if (setting === false) return async () => {};
  const command = setting === true ? defaultKeepAwakeCommand() : setting.command;
  const warn = (detail: string) => note(`Keep-awake command unavailable; the computer may sleep: ${shorten(detail, 400)}`);
  if (!command) {
    warn(`No default command for ${process.platform}`);
    return async () => {};
  }
  const [program, ...args] = command.map(part => part.replaceAll("{pid}", String(process.pid)));
  let stopping = false;
  let ended = false;
  let output = "";
  try {
    const child = spawn(program!, args, { stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
    const exited = new Promise<void>(resolve => {
      child.once("error", error => { ended = true; warn(error.message); resolve(); });
      child.once("exit", (code, signal) => {
        ended = true;
        if (!stopping) warn(`Exited (${signal ?? code})${output ? `: ${output}` : ""}`);
        resolve();
      });
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8").on("data", (text: string) => {
        output = (output + text).slice(-2000);
        note(`Keep-awake command output: ${shorten(text, 400)}`);
      });
    }
    // Observe spawn failure before launching the worker, without making it a refusal.
    await new Promise<void>(resolve => { child.once("spawn", resolve); child.once("error", () => resolve()); });
    if (!ended) note(`Keep-awake command started (pid ${child.pid})`);
    return async () => {
      stopping = true;
      try {
        if (!ended && child.pid) {
          if (process.platform === "win32") {
            const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
            const result = await runCommand("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { cwd: process.cwd(), env, timeoutMs: 5000 });
            if (result.exitCode !== 0 && !ended) warn(`Could not stop process tree: ${result.stderr || result.stdout}`);
          } else child.kill("SIGTERM");
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]);
          } finally { clearTimeout(timer); }
          if (!ended) {
            child.kill("SIGKILL");
            warn("The command did not stop on request; forced termination was sent");
          }
        }
      } catch (error) { warn(`Could not stop command: ${String(error)}`); }
      finally { child.stdout.destroy(); child.stderr.destroy(); }
    };
  } catch (error) {
    warn(String(error));
    return async () => {};
  }
}
