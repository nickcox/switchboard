import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeOwners } from "../scenario/owners.ts";
import { HostClient } from "./client.ts";
import { fixtureDirectory } from "./paths.ts";

const [command, directoryArgument, argument, waitArgument] = process.argv.slice(2);
try {
  if (!directoryArgument) throw new Error("Expected init|host|submit|inspect|diagnostics|advance|wait|cancel|shutdown <fixture-directory> [argument]");
  const directory = await fixtureDirectory(directoryArgument);
  const client = new HostClient(directory);
  if (command === "init") {
    const { ExecutionHost } = await import("./host.ts");
    const ids = (argument ?? "request-1,one,two,three").split(",");
    await writeFile(join(directory, "config.json"), JSON.stringify({ maxAttempts: 1 }), { flag: "wx", flush: true });
    const owners = new FakeOwners(join(directory, "owners"), join(directory, "host"));
    await owners.initialise();
    const host = await ExecutionHost.open(directory, owners, { seedTaskIds: ids.map(id => `task-${id}`) });
    await host.close();
    console.log(JSON.stringify({ status: "initialised", directory }));
  } else if (command === "host") {
    const { ExecutionHost } = await import("./host.ts");
    const config = JSON.parse(await readFile(join(directory, "config.json"), "utf8"));
    const owners = new FakeOwners(join(directory, "owners"), join(directory, "host"));
    const host = await ExecutionHost.open(directory, owners, { maxAttempts: config.maxAttempts });
    const ready = { status: "ready", pid: process.pid, port: host.endpoint.port };
    console.log(JSON.stringify(ready));
    process.send?.(ready);
    const stop = () => { void host.close().catch(error => { console.error(error); process.exitCode = 1; }); };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    // The listening server owns the process lifetime. No detached child or service is started.
    if (process.connected) process.disconnect?.();
  } else {
    let result: unknown;
    if (command === "submit" && argument) {
      const request = JSON.parse(await readFile(argument, "utf8"));
      result = await client.submit(request);
      if (waitArgument && typeof result === "object" && result !== null && "status" in result && result.status === "waiting") {
        result = await client.wait(request.requestId, Number(waitArgument));
      }
    } else if (command === "inspect" || command === "diagnostics" || command === "shutdown") result = await client.call(command);
    else if (command === "advance" && argument) result = await client.advance(argument);
    else if (command === "cancel" && argument) result = await client.cancel(argument);
    else if (command === "wait" && argument) result = await client.wait(argument, Number(waitArgument ?? 10_000));
    else throw new Error("Unknown command or missing request file/ID");
    console.log(JSON.stringify(result));
    if (result && typeof result === "object" && "status" in result && result.status === "refused") process.exitCode = 2;
  }
} catch (error) {
  console.error(JSON.stringify({ status: "refused", code: "host_unavailable", nextAction: String(error) }));
  process.exitCode = 2;
}
