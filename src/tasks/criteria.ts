import { z } from "zod";

export const acceptanceCriteriaSchema = z.array(z.string().min(1).refine(value => value.trim().length > 0 && !/[\r\n]/.test(value)));

/** Only flat, single-line bullets are safe to move without interpreting Markdown. */
export function criteriaSection(body: string): { body: string; acceptanceCriteria: string[] } | { reason: string } | undefined {
  const lines = body.split(/\r?\n/);
  const headings: number[] = [];
  let fence: string | undefined;
  for (const [index, line] of lines.entries()) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
    }
    if (!fence && /^## Acceptance criteria\s*$/.test(line)) headings.push(index);
  }
  if (!headings.length) return undefined;
  if (headings.length !== 1) return { reason: "More than one acceptance criteria section" };
  const start = headings[0]!;
  let end = start + 1;
  while (end < lines.length && !/^#{1,2}\s/.test(lines[end]!)) end++;
  const acceptanceCriteria: string[] = [];
  for (const line of lines.slice(start + 1, end)) {
    if (!line.trim()) continue;
    const bullet = /^[-*+]\s+(\S.*)$/.exec(line);
    if (!bullet) return { reason: "Section is not a flat, single-line bullet list" };
    acceptanceCriteria.push(bullet[1]!.trimEnd());
  }
  if (!acceptanceCriteria.length) return { reason: "Section has no bullet list" };
  return { body: [...lines.slice(0, start), ...lines.slice(end)].join("\n"), acceptanceCriteria };
}
