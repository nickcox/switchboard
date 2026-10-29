import { basename } from "node:path";

if (basename(process.argv[1] ?? "") === "dispatch-process.ts") {
  console.error("Synthetic dispatcher exit before reservation");
  process.exit(17);
}
