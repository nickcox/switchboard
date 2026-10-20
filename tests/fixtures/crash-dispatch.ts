// Child process for the crash tests: runs a real dispatch from a configuration file and kills itself with SIGKILL
// at the requested point, so no cleanup or compensation code can run.
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createDependencies, loadConfig } from "../../src/config.ts";
import { dispatchOnce } from "../../src/dispatch/dispatch.ts";

const [configPath, stage] = process.argv.slice(2);
const config = await loadConfig(configPath!);
const deps = await createDependencies(config);
const die = () => process.kill(process.pid, "SIGKILL");

if (stage === "after-lease") {
  const real = deps.workspaces;
  deps.workspaces = { recyclableRoots: () => real.recyclableRoots(), returnLease: (lease, options) => real.returnLease(lease, options), leases: () => real.leases(), pool: () => real.pool(), acquire: async request => { await real.acquire(request); die(); throw new Error("unreachable"); } };
} else if (stage === "after-start") {
  const real = deps.tasks;
  deps.tasks = {
    ready: () => real.ready(), inFlight: () => real.inFlight(), read: id => real.read(id),
    recordDone: (id, note) => real.recordDone(id, note), recordHold: (id, hold) => real.recordHold(id, hold),
    start: async id => { await real.start(id); die(); throw new Error("unreachable"); },
  };
} else if (stage === "after-launch") {
  const real = deps.launch;
  const log = config.worker.environment?.FAKE_PI_LOG;
  deps.launch = async (input, signal) => {
    const running = real(input, signal);
    // Die once the worker has received its prompt, before its exit can be observed and recorded.
    while (!(log && existsSync(log) && readFileSync(log, "utf8").includes('"type":"prompt"'))) await sleep(5);
    die();
    return running;
  };
} else {
  throw new Error(`Unknown stage ${stage}`);
}
await dispatchOnce(deps, { requestId: `crash-${stage}` });
throw new Error("The dispatcher should have been killed");
