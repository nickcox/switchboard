import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { HostClient } from "../design-b/client.ts";
import { fixtureDirectory } from "../design-b/paths.ts";
import type { Interrupt } from "../scenario/contract.ts";
import { approve, inspect, recoverClaim, review, waitForWorker } from "./control.ts";
import { initialise, settingsAt } from "./fixture.ts";
import { openHost } from "./host.ts";

const usage = `Usage: node investigations/durable-orchestration/real/cli.ts <command> <fixture-directory> [options]
Commands: init, run, host, submit, wait, advance, inspect, review, approve, shutdown, recover-claim
init --design A|B --config <switchboard.json> --instructions <file>
run starts a foreground host, submits the stable fixture request and waits for review.
host starts a foreground host without submitting. Neither command starts another host process.
host/run --stop-after-acquire kills this host at workspace:ack:before, retaining its claim and lease.
review --attempt <id> --commit <sha> [--decision accepted|rejected]
approve --attempt <id> --lease <id> --commit <sha> --accept [--no-processes] [--expires-ms 3600000]
recover-claim --confirm-host-stopped --confirm-no-processes removes only a stale fixture host claim.
wait [--wait-ms <milliseconds>] stops waiting at review or refusal; advance checks finalisation once.
inspect reads real leases, receipts, independent counters and host state. shutdown retains leases.`;

try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    design: { type: "string" }, config: { type: "string" }, instructions: { type: "string" },
    attempt: { type: "string" }, lease: { type: "string" }, commit: { type: "string" }, decision: { type: "string", default: "accepted" },
    accept: { type: "boolean" }, "no-processes": { type: "boolean" }, "expires-ms": { type: "string", default: "3600000" },
    "wait-ms": { type: "string" }, "stop-after-acquire": { type: "boolean" },
    "confirm-host-stopped": { type: "boolean" }, "confirm-no-processes": { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) { console.log(usage); } else {
    const [command, path] = positionals;
    if (!command || !path) throw new Error(usage);
    if (values["wait-ms"] !== undefined && (!Number.isFinite(Number(values["wait-ms"])) || Number(values["wait-ms"]) <= 0)) {
      throw new Error("Supply a positive --wait-ms duration");
    }
    const directory = await fixtureDirectory(path);
    const required = (value: string | undefined, name: string): string => {
      if (!value) throw new Error(`Supply --${name}`);
      return value;
    };
    const print = (value: unknown) => {
      console.log(JSON.stringify(value, null, 2));
      if (value && typeof value === "object" && "status" in value && value.status === "refused") process.exitCode = 2;
    };
    if (command === "init") {
      if (values.design !== "A" && values.design !== "B") throw new Error("Supply --design A or B");
      print({ directory: await initialise(directory, values.design, required(values.config, "config"), required(values.instructions, "instructions")) });
    } else if (command === "host" || command === "run") {
      const interrupt: Interrupt = async point => {
        if (values["stop-after-acquire"] && point === "workspace:ack:before") {
          await writeFile(join(directory, "interruption.json"), JSON.stringify({ point, pid: process.pid }), { flag: "wx", flush: true });
          process.send?.({ type: "boundary", point });
          process.kill(process.pid, "SIGKILL");
          await new Promise<void>(() => {});
        }
      };
      const host = await openHost(directory, interrupt);
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        void host.close().then(() => process.disconnect?.(), error => { console.error(error); process.exitCode = 1; process.disconnect?.(); });
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      print({ status: "ready", directory, pid: process.pid });
      process.send?.({ type: "ready" });
      if (command === "run") {
        const settings = await settingsAt(directory);
        const submitted = await new HostClient(directory).submit(settings.request);
        print(submitted);
        if (submitted.status === "waiting" && submitted.waitingFor === "worker") {
          print(await waitForWorker(directory, Number(values["wait-ms"] ?? settings.worker.runMs + 20_000)));
        }
      }
      // The server keeps this foreground process alive. shutdown releases the host claim.
      process.disconnect?.();
    } else if (command === "inspect") print(await inspect(directory));
    else if (command === "review") {
      if (values.decision !== "accepted" && values.decision !== "rejected") throw new Error("Use accepted or rejected");
      await review(directory, required(values.attempt, "attempt"), required(values.commit, "commit"), values.decision);
      print({ status: "review_recorded" });
    } else if (command === "approve") {
      await approve(directory, { attemptId: required(values.attempt, "attempt"), leaseId: required(values.lease, "lease"),
        commit: required(values.commit, "commit"), accept: values.accept === true, noProcesses: values["no-processes"] === true,
        expiresMs: Number(values["expires-ms"]) });
      print({ status: "approval_recorded" });
    } else if (command === "recover-claim") {
      await recoverClaim(directory, values["confirm-host-stopped"] === true, values["confirm-no-processes"] === true);
      print({ status: "fixture_claim_removed", leases: "retained" });
    } else {
      const client = new HostClient(directory);
      const settings = await settingsAt(directory);
      if (command === "submit") print(await client.submit(settings.request));
      else if (command === "advance") print(await client.advance(settings.request.requestId));
      else if (command === "wait") print(await waitForWorker(directory, Number(values["wait-ms"] ?? settings.worker.runMs + 20_000)));
      else if (command === "shutdown") print(await client.call("shutdown"));
      else throw new Error(usage);
    }
  }
} catch (error) { console.error(String(error)); process.exitCode = 2; process.disconnect?.(); }
