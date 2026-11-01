import { format } from "node:util";
import { runCli } from "../src/cli.ts";

/**
 * Runs the CLI in this process, as spawnSync would run it in another, for checks that need no process of their own:
 * starting Node for each refusal is most of those tests' time, especially on Windows. Tests in one file run one at a time,
 * so replacing the console and environment for the duration of a call cannot affect another test.
 */
export async function cliInProcess(args: string[], environment: Record<string, string | undefined> = {}): Promise<{ status: number; stdout: string; stderr: string }> {
  let stdout = "", stderr = "";
  const { log, error } = console;
  const previous = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name]]));
  console.log = (...values: unknown[]) => { stdout += `${format(...values)}\n`; };
  console.error = (...values: unknown[]) => { stderr += `${format(...values)}\n`; };
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try { return { status: await runCli(args), stdout, stderr }; }
  finally {
    console.log = log;
    console.error = error;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
