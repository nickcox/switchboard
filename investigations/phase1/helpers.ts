import { appendFileSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";

export const root = realpathSync(resolve(import.meta.dir, "../.."));
const runs = join(root, ".investigation/runs");
mkdirSync(runs, { recursive: true });
export const runDir = mkdtempSync(join(runs, "probe-"));
export const node = Bun.which("node");
export const treehouse = Bun.which("treehouse");
if (!node || !treehouse) throw new Error("Probes require Node.js and Treehouse on PATH");
export const tasksBin = resolve(import.meta.dir, "node_modules/tasks-axi/dist/bin/tasks-axi.js");

export function fixture(name: string) {
  const dir = mkdtempSync(join(runDir, `${name}-`));
  for (const child of ["home", "config", "tmp"]) mkdirSync(join(dir, child));
  return {
    dir,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: join(dir, "home"),
      XDG_CONFIG_HOME: join(dir, "config"),
      TMPDIR: join(dir, "tmp"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Switchboard fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Switchboard fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      PI_OFFLINE: "1",
    },
  };
}
export type Fixture = ReturnType<typeof fixture>;

export async function command(
  f: Fixture,
  cmd: string[],
  options: { cwd?: string; env?: Record<string, string>; allowFailure?: boolean } = {},
) {
  const cwd = options.cwd ?? f.dir;
  const child = Bun.spawn(cmd, {
    cwd,
    env: { ...f.env, ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  appendFileSync(join(runDir, "commands.jsonl"), `${JSON.stringify({ cmd, cwd, code, stdout, stderr })}\n`);
  if (code !== 0 && !options.allowFailure) {
    throw new Error(`${cmd.join(" ")} exited ${code}\n${stderr}\n${stdout}`);
  }
  return { stdout, stderr, code };
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value as Record<string, unknown>;
}
export function objects(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected array");
  return value.map(object);
}
export function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string");
  return value;
}

console.log(`Investigation evidence: ${runDir}`);
