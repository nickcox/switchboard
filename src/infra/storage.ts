import { realpath } from "node:fs/promises";
import { dirname, join, basename, relative, isAbsolute, sep } from "node:path";

export function inside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

/** Resolve existing ancestors too, so a not-yet-created path cannot hide behind a directory link. */
export async function resolvedPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await resolvedPath(parent), basename(path));
  }
}

export async function requireRetainedStorage(path: string, recyclableRoots: string[]): Promise<void> {
  const resolved = await resolvedPath(path);
  for (const root of recyclableRoots) {
    if (inside(root, path) || inside(await resolvedPath(root), resolved)) {
      throw new Error(`Storage must be outside every recyclable workspace: ${path}`);
    }
  }
}
