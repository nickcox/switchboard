import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** Absolute path of an executable on PATH, for tests that run real external tools. */
export function onPath(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* Keep searching. */ }
  }
  throw new Error(`${name} must be on PATH for these tests`);
}
