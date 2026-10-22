import type { Interrupt, Point } from "./contract.ts";
import { interruptionPoints } from "./contract.ts";

// The parent owns termination. There is deliberately no graceful-shutdown or self-exit path.
export function pauseAt(target: Point): Interrupt {
  if (!interruptionPoints.includes(target)) throw new Error(`Unknown interruption point: ${target}`);
  return async point => {
    if (point !== target) return;
    if (!process.send) throw new Error("Interruption tests require a child IPC channel");
    await new Promise<void>((resolve, reject) => {
      process.send!({ type: "interruption", point }, error => error ? reject(error) : resolve());
    });
    await new Promise<never>(() => {
      // Keep the paused process alive until its parent kills it, even if no other work is active.
      setInterval(() => {}, 1_000);
    });
  };
}
