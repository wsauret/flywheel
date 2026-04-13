// Command Extraction — handoff → DeclaredCommand[]
//
// Thin adapter over `parseRawHandoff().commandsRun`.

import { parseRawHandoff } from "./handoff-parse.js";
import type { DeclaredCommand } from "../../shared/native-verification.js";

/**
 * Extract declared commands from a raw handoff record.
 * Thin adapter over `parseRawHandoff().commandsRun`.
 */
export function extractDeclaredCommands(
  handoffData: Record<string, unknown> | null,
): DeclaredCommand[] {
  if (!handoffData) return [];

  const parsed = parseRawHandoff(handoffData);
  const result: DeclaredCommand[] = [];

  for (const entry of parsed.commandsRun) {
    if (typeof entry === "string") {
      result.push({ command: entry });
    } else if (entry && typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      if (typeof obj.command === "string") {
        result.push({
          command: obj.command,
          reportedExitCode: typeof obj.exitCode === "number" ? obj.exitCode : undefined,
          observation: typeof obj.observation === "string" ? obj.observation : undefined,
        });
      }
    }
  }

  return result;
}
