const mode = process.argv[2];
if (mode === "cooperative") {
  process.on("SIGTERM", () => setTimeout(() => process.exit(0), 100));
} else if (mode === "stubborn") {
  process.on("SIGTERM", () => {});
} else {
  throw new Error("Expected cooperative or stubborn mode");
}
console.log(JSON.stringify({ pid: process.pid, cwd: process.cwd(), taskId: process.env.PROBE_TASK_ID, leaseId: process.env.PROBE_LEASE_ID }));
setInterval(() => {}, 1000);
