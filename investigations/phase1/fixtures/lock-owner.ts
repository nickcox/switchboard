import { dlopen, FFIType } from "bun:ffi";
import { closeSync, constants, openSync } from "node:fs";
import { tryLock } from "fs-native-extensions";

if (process.platform !== "darwin") throw new Error("This flock probe targets macOS only");
const path = process.argv[2];
const mode = process.argv[3] ?? "once";
const backend = process.argv[4] ?? "ffi";
if (!path) throw new Error("Expected lock path");
const libc = dlopen("/usr/lib/libSystem.B.dylib", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  // F_GETFD has no variadic argument. Do not bind F_SETFD this way on arm64.
  fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});
// Darwin O_CLOEXEC is not exposed by node:fs constants in this runtime.
const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | 0x01000000, 0o600);
// Darwin: LOCK_EX = 2, LOCK_NB = 4, F_GETFD = 1, FD_CLOEXEC = 1.
const flags = libc.symbols.fcntl(fd, 1);
if (flags < 0) throw new Error("F_GETFD failed");
const closeOnExec = (flags & 1) !== 0;
// FFI is a capability proof, not a selected production binding.
// Calling the addon is an opt-in incompatibility reproduction on Bun 1.3.11.
const locked = backend === "addon" ? tryLock(fd) : libc.symbols.flock(fd, 2 | 4) === 0;
let childPid: number | undefined;
if (locked && mode === "with-child") {
  const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30000)"], {
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  childPid = child.pid;
}
console.log(JSON.stringify({ locked, closeOnExec, backend, pid: process.pid, childPid }));
if (!locked || mode === "once") {
  closeSync(fd);
  libc.close();
  process.exit(locked ? 0 : 73);
}
process.on("SIGTERM", () => {
  closeSync(fd);
  libc.close();
  process.exit(0);
});
setInterval(() => {}, 1000);
