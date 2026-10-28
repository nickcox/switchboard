// Synthetic request sender only. It never starts a worker.
import { RuntimeRecords } from "../../src/runtime/records.ts";
import { claimRequest, submitRequest } from "../../src/runtime/requests.ts";

const [root, path, context, claimId, mode, requestId] = process.argv.slice(2) as [string, string, string, string, string, string?];
const record = (await new RuntimeRecords(root, path).discover(context)).find(record => record.claimId === claimId)!;
if (mode === "foreign") {
  console.log(JSON.stringify({ dispatcher: await claimRequest(record, requestId!, "dispatcher"), withdrawn: await claimRequest(record, requestId!, "withdrawn") }));
} else {
  const request = await submitRequest(record, { kind: "person", id: "operator:subprocess" }, { kind: "stop" });
  process.send!({ id: request.id });
  process.once("message", () => {
    void claimRequest(record, request.id, "withdrawn").then(won => {
      process.send!({ withdrawn: won }, () => process.disconnect!());
    }, error => { console.error(error); process.exitCode = 1; process.disconnect!(); });
  });
}
