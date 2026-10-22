import { writeFileSync } from "node:fs";

const [path, dispatcher, embedded] = process.argv.slice(2);
writeFileSync(path!, JSON.stringify({ pid: process.pid, dispatcher, embedded }));
console.log("Fake power assertion held");
setInterval(() => {
  try { process.kill(Number(dispatcher), 0); }
  catch { process.exit(0); }
}, 100);
