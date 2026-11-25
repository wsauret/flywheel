type AssistantPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking" | "reasoning" | "tool_use" | "image" };

/** The thought text a persisted reasoning part shows: its summary parts, as
 *  the live row and the reopened transcript both state it. Empty when the
 *  part keeps no summary, such as raw reasoning text the provider does not
 *  return with the item. */
export function reasoningSummaryText(part: { readonly summary?: readonly { readonly text: string }[] }): string {
  return (part.summary ?? []).map((item) => item.text).join("\n\n");
}

/** Walks canonical parts without filtering their coordinates. Only adjacent
 * text parts join; even a hidden part ends a public text run.
 * @yields {object} Each run's first canonical part, original index, and joined text. */
export function* assistantContentRuns<T extends AssistantPart>(content: readonly T[]): Generator<{
  readonly part: T;
  readonly index: number;
  readonly text?: string;
}> {
  let run: { part: T; index: number; text?: string } | undefined;
  for (const [index, part] of content.entries()) {
    if (part.type === "text" && run?.text !== undefined) {
      run.text += part.text;
      continue;
    }
    if (run) yield run;
    run = { part, index, ...(part.type === "text" ? { text: part.text } : {}) };
  }
  if (run) yield run;
}
