import { writeFileSync } from "node:fs";

writeFileSync(process.env.FAKE_PI_SUPERVISOR_LOG!, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
