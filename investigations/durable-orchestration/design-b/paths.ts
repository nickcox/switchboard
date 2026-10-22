import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const temporaryRoot = fileURLToPath(new URL("../../../.investigation/durable-orchestration/", import.meta.url));

export async function fixtureDirectory(path: string): Promise<string> {
  const directory = resolve(path);
  const within = relative(temporaryRoot, directory);
  if (!within || within.startsWith("..") || isAbsolute(within)) throw new Error("Use a disposable directory under .investigation/durable-orchestration");
  await mkdir(directory, { recursive: true });
  const canonical = await realpath(directory);
  const root = await realpath(temporaryRoot);
  const canonicalWithin = relative(root, canonical);
  if (!canonicalWithin || canonicalWithin.startsWith("..") || isAbsolute(canonicalWithin)) throw new Error("Fixture directory escapes temporary storage");
  return canonical;
}
