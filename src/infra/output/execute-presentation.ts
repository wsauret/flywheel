import type { ToolEntry } from "../output-blocks.js";

interface NestedExecuteInput {
  readonly [key: string]: unknown;
}

/** Presentation for a nested Code Mode call on the Executed rail: the tool
 *  name as called, plus a `[key=value, ...]` summary of primitive input fields
 *  only. Objects and arrays are omitted; an input with no primitive fields
 *  yields an empty detail. Shared by the live projector and the historical
 *  reconstruction so the two paths cannot drift. */
export function nestedExecutePresentation(name: string, input: NestedExecuteInput | undefined): ToolEntry["presentation"] {
  const details = input
    ? Object.entries(input)
      .filter((entry): entry is [string, string | number | boolean] => {
        const value = entry[1];
        return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
      })
      .map(([key, value]) => `${key}=${String(value)}`)
    : [];
  return { name, detail: details.length > 0 ? `[${details.join(", ")}]` : "" };
}
