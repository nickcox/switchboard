type ResultValue = {
  ok?: boolean; detail?: string; summary?: string; reason?: string;
  tasks?: { state?: string }[];
  task?: { id: string; state?: string };
  attempt?: { taskId: string; attempt: number };
  objective?: { id: string; state: string; spending?: { cost?: number | null }; budget?: { maxCost?: number | null } };
  openPersonQuestions?: unknown[]; openQuestions?: unknown[];
  question?: { text?: string; answer?: { text: string } };
};
const record = (value: unknown): ResultValue => value !== null && typeof value === "object" ? value as ResultValue : {};
const line = (value: unknown) => String(value).replace(/\s+/g, " ").trim();

export type RenderResult = { content: { type: string; text?: string }[]; details?: unknown };
export type TextComponent = (text: string) => { render(width: number): string[]; invalidate(): void };

export function resultSummary(command: string, result: RenderResult): string {
  let value = record(result.details);
  if (!Object.keys(value).length) {
    try { value = record(JSON.parse(result.content.map(part => part.text ?? "").join("\n"))); }
    catch { return `${command}: ${line(result.content.map(part => part.text ?? "").join(" ")) || "No result"}`; }
  }
  const label = command[0]!.toUpperCase() + command.slice(1);
  if (value.ok === false) return `${label} refused: ${line(value.detail ?? value.summary ?? value.reason ?? "Unknown reason")}`;
  if (command === "briefing") {
    const tasks = value.tasks ?? [];
    const running = tasks.filter(task => task.state === "in_flight").length;
    const done = tasks.filter(task => task.state === "done").length;
    const questions = (value.openPersonQuestions?.length ?? 0) + (value.openQuestions?.length ?? 0);
    const objective = value.objective ?? {};
    const spending = objective.spending ?? {};
    const cost = typeof spending.cost === "number" ? `$${spending.cost.toFixed(2)}` : "unknown cost";
    const maximum = objective.budget?.maxCost;
    return `Briefing: ${tasks.length} tasks (${running} running, ${done} done), ${questions} open question${questions === 1 ? "" : "s"}, ${cost}${typeof maximum === "number" ? ` of $${maximum}` : ""} spent`;
  }
  if (command === "dispatch" && value.attempt) return `${value.reason === "existing_request" ? "Existing dispatch:" : "Dispatched"} ${value.attempt.taskId} attempt ${value.attempt.attempt}`;
  if (value.summary) return `${label}: ${line(value.summary)}${value.detail ? ` ${line(value.detail)}` : ""}`;
  if (command === "ask") return `Question for the person: ${line(value.question?.text ?? "recorded")}`;
  if (command === "note") return "Supervisor note recorded";
  if (value.task) return `${label}: ${value.task.id}${value.task.state ? ` (${value.task.state})` : ""}`;
  if (Array.isArray(value.tasks)) return `${label}: ${value.tasks.length} tasks`;
  if (value.objective) return `${label}: ${value.objective.id} (${value.objective.state})`;
  if (value.question?.answer) return `Answer recorded: ${line(value.question.answer.text)}`;
  return `${label}: ${line(value.detail ?? value.reason ?? "done")}`;
}

export function resultRenderer(command: string) {
  return (result: RenderResult, options: { expanded: boolean; isPartial?: boolean }, makeText: TextComponent) => {
    const text = options.isPartial ? `${command}: working…` : options.expanded
      ? result.content.map(part => part.text ?? "").join("\n") : resultSummary(command, result);
    return makeText(text);
  };
}
