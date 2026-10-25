import { fork, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";

export type Host = { child: ChildProcess; exited: Promise<{ code: number | null; signal: string | null }>;
  boundary: Promise<void>; output: () => string };

export function start(hostFile: string, directory: string, mode: string): Host {
  const child = fork(hostFile, [directory, mode], { execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = "";
  child.stdout!.on("data", data => { output += data; });
  child.stderr!.on("data", data => { output += data; });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
  const boundary = new Promise<void>((resolve, reject) => {
    child.on("message", message => { if ((message as { type: string }).type === "boundary") resolve(); });
    child.once("exit", () => reject(new Error(`Host exited before boundary: ${output}`)));
    child.once("error", reject);
  });
  // Non-pausing processes never reach the boundary; still observe their rejection.
  void boundary.catch(() => {});
  return { child, exited, boundary, output: () => output };
}
export async function stop(host: Host): Promise<void> {
  if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill("SIGKILL");
  await host.exited;
}
export async function json<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")); }
export async function lines<T>(path: string): Promise<T[]> {
  return (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
}
