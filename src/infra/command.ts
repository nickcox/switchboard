import { spawn } from "node:child_process";

export type CommandResult = {
  /** Null when the process ended on a signal, including a timeout kill. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

/**
 * Runs an external command without a shell and with closed stdin. A command that exceeds its timeout is killed and
 * reported as `timedOut`, which callers treat as an unknown outcome rather than a failure.
 */
export async function runCommand(
  executable: string, args: string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<CommandResult> {
  const child = spawn(executable, args, {
    cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
  child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs);
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve(signal ? null : code));
    });
    return { exitCode, stdout, stderr, timedOut };
  } finally { clearTimeout(timer); }
}

export function describeCommand(result: CommandResult): string {
  return JSON.stringify({
    exitCode: result.exitCode, timedOut: result.timedOut,
    stdout: result.stdout.slice(-2000), stderr: result.stderr.slice(-2000),
  });
}
