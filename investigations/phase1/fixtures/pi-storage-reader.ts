import { SessionManager } from "@earendil-works/pi-coding-agent";

const dir = process.argv[2];
if (!dir) throw new Error("Expected isolated session directory");
// Reads fixture storage only. Does not create an agent, launch Pi or call a model.
const sessions = await SessionManager.listAll(dir);
console.log(JSON.stringify(sessions.map(info => {
  const manager = SessionManager.open(info.path);
  return { id: info.id, cwd: info.cwd, entries: manager.getEntries() };
})));
