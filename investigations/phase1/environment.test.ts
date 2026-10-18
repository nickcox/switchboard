import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import { command, fixture, node, runDir, tasksBin, treehouse } from "./helpers.ts";

test("record and verify the selected investigation versions", async () => {
  const f = fixture("versions");
  const treehouseVersion = (await command(f, [treehouse!, "--version"])).stdout.trim();
  const tasksVersion = (await command(f, [node!, tasksBin, "--version"])).stdout.trim();
  const nodeVersion = (await command(f, [node!, "--version"])).stdout.trim();
  const os = (await command(f, ["sw_vers"])).stdout.trim();
  const binaryHash = new Bun.CryptoHasher("sha256").update(await Bun.file(treehouse!).arrayBuffer()).digest("hex");
  const environment = {
    recordedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    kernel: release(),
    os,
    bun: Bun.version,
    bunRevision: Bun.revision,
    node: nodeVersion,
    treehouse: treehouseVersion,
    treehouseSha256: binaryHash,
    tasksAxi: tasksVersion,
    piSdk: JSON.parse(await Bun.file(join(import.meta.dir, "node_modules/@earendil-works/pi-coding-agent/package.json")).text()).version,
    nativeLock: JSON.parse(await Bun.file(join(import.meta.dir, "node_modules/fs-native-extensions/package.json")).text()).version,
  };
  writeFileSync(join(runDir, "environment.json"), `${JSON.stringify(environment, null, 2)}\n`);
  expect(process.platform).toBe("darwin");
  expect(Bun.version).toBe("1.3.11");
  expect(treehouseVersion).toBe("v3.1.3");
  expect(tasksVersion).toContain("0.2.6");
  expect(environment.piSdk).toBe("1.2.0");
  expect(environment.nativeLock).toBe("1.5.1");
});
