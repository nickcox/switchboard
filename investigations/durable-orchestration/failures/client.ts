import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Deliberately tiny fixture CLI. It owns no execution state and never starts a host.
const [directory, json] = process.argv.slice(2) as [string, string];
const { port } = JSON.parse(await readFile(join(directory, "matrix-endpoint.json"), "utf8"));
const response = await fetch(`http://127.0.0.1:${port}`, {
  method: "POST", body: json, signal: AbortSignal.timeout(15_000),
});
console.log(await response.text());
if (!response.ok) process.exitCode = 2;
