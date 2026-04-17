import type { UserEventToolResult } from "../../../../../infra/ndjson-event-types.js";

export function formatStdinInput(input: string | UserEventToolResult): string {
  if (typeof input === "string") {
    return JSON.stringify({ type: "user", message: { role: "user", content: input } }) + "\n";
  }
  return JSON.stringify({ type: "user", message: { role: "user", content: [input] } }) + "\n";
}
