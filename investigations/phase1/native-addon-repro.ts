import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { command, fixture, node, object, runDir } from "./helpers.ts";

// Opt-in only: this intentionally reproduces a native Bun crash in a child.
const f = fixture("native-addon-repro");
const script = join(import.meta.dir, "fixtures/native-addon-lock.cjs");
const path = join(f.dir, "probe.lock");
const control = await command(f, [node!, script, path]);
if (object(JSON.parse(control.stdout)).locked !== true) throw new Error("Node control failed");
const result = await command(f, [process.execPath, script, path], { allowFailure: true });
const reproduced = result.code !== 0 && result.stderr.includes("uv_get_osfhandle");
writeFileSync(join(runDir, "native-addon-repro.json"), `${JSON.stringify({ bun: Bun.version, nativeAddon: "fs-native-extensions@1.5.1", nodeControl: control, bunResult: result, reproduced }, null, 2)}\n`);
if (!reproduced) throw new Error("Expected incompatibility was not reproduced; reassess this dependency");
console.log("Confirmed: the same native lock call succeeds under Node and crashes Bun 1.3.11 at uv_get_osfhandle.");
