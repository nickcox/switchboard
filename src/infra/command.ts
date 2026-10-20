import { spawn } from "node:child_process";

export type CommandResult = {
  /** Null when the process ended on a signal, including a timeout kill. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when either stream exceeded the output limit and only its end was kept. */
  truncated: boolean;
};

/** Each stream keeps at most this many characters, from its end: far more than any expected output, including task bodies. */
const outputLimit = 16 * 1024 * 1024;
/** How long to keep reading output after the command exits, for output still in its pipes. */
const drainMs = 500;

/**
 * Runs an external command without a shell and with closed stdin. A command that exceeds its timeout is killed and
 * reported as `timedOut`, which callers treat as an unknown outcome rather than a failure.
 *
 * The result is returned soon after the command itself exits, even if a process it started still holds its output
 * pipes open; that process is not waited for, killed or claimed to have stopped.
 */
export async function runCommand(
  executable: string, args: string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<CommandResult> {
  const child = spawn(executable, args, {
    cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let truncated = false;
  const keep = (text: string) => {
    if (text.length <= outputLimit) return text;
    truncated = true;
    return text.slice(-outputLimit);
  };
  child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout = keep(stdout + text); });
  child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr = keep(stderr + text); });
  let timedOut = false;
  let drain: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs);
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      let exit: number | null = null;
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        exit = signal ? null : code;
        // Stop waiting for the pipes to close once the drain period ends, and release them.
        drain = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); resolve(exit); }, drainMs);
      });
      child.once("close", (code, signal) => resolve(signal ? null : code));
    });
    return { exitCode, stdout, stderr, timedOut, truncated };
  } finally {
    clearTimeout(timer);
    clearTimeout(drain);
  }
}

export function describeCommand(result: CommandResult): string {
  return JSON.stringify({
    exitCode: result.exitCode, timedOut: result.timedOut, ...(result.truncated ? { truncated: true } : {}),
    stdout: result.stdout.slice(-2000), stderr: result.stderr.slice(-2000),
  });
}
