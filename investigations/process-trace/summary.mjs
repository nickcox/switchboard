// Prints the count and duration of each kind of child process recorded by trace-processes.mjs.
import { readFileSync } from "node:fs";

const rows = readFileSync(process.argv[2], "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const groups = new Map();
for (const { name, ms } of rows) {
  const group = groups.get(name) ?? { count: 0, total: 0, values: [] };
  group.count++; group.total += ms; group.values.push(ms);
  groups.set(name, group);
}
console.log(`${rows.length} processes`);
for (const [name, { count, total, values }] of [...groups].sort((a, b) => b[1].total - a[1].total).slice(0, 25)) {
  values.sort((a, b) => a - b);
  console.log(`${String(count).padStart(6)} x ${name.padEnd(30)} total ${(total / 1000).toFixed(1).padStart(7)}s  median ${values[Math.floor(count / 2)].toFixed(0).padStart(5)}ms  p90 ${values[Math.floor(count * 0.9)].toFixed(0).padStart(5)}ms`);
}
