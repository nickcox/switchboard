import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Windows looks up an executable by its extension. Only .com and .exe are tried, because Node.js cannot start a .cmd or
 * .bat file without a shell.
 */
const extensions = process.platform === "win32" ? [".com", ".exe"] : [""];

/** Absolute path of an executable found on PATH. */
export function onPath(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(directory, name + extension);
      // On Windows the execute check only tests that the path exists, so also require a regular file.
      try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return candidate; } catch { /* Keep searching. */ }
    }
  }
  throw new Error(`${name} was not found on PATH`);
}
