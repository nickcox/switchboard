declare module "tasks-axi/dist/src/backends/markdown.js" {
  export type AxiTask = {
    id: string; title: string; state: "queued" | "in_flight" | "done";
    repo?: string; kind?: string; body?: string; hold?: { reason: string; until?: string };
    deps: { id: string; type: string }[];
  };
  export class MarkdownStore {
    constructor(options: { path: string; archivePath?: string });
    list(query: object): Promise<{ items: AxiTask[]; total: number }>;
  }
}
declare module "tasks-axi/dist/src/derive.js" {
  import type { AxiTask } from "tasks-axi/dist/src/backends/markdown.js";
  export function readyTasks(tasks: AxiTask[]): AxiTask[];
  export function isHoldActive(task: AxiTask): boolean;
}
