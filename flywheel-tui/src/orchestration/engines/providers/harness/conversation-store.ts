/**
 * Conversation persistence for the harness engine.
 *
 * Mirrors subprocess engine's `--resume <sessionId>` semantics using a JSONL
 * file per harness runner. The subprocess engine delegates this to Claude
 * Code's on-disk session files; the harness owns its own Message[] so it
 * persists them directly.
 *
 * Storage layout: `<sessionDir>/conversations/<harnessSessionId>.jsonl`
 * where sessionDir is derived from the runner's handoffPath:
 *   handoffPath = <sessionDir>/handoffs/<handoff-file>
 *
 * Each line is one JSON-serialized `Message` (role + content blocks).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Log } from "../../../../infra/log.js";
import { errorMessage } from "../../../../infra/error-message.js";
import type { Message } from "./llm/types.js";

const log = Log.create({ service: "harness-conversation-store" });

/** Resolve the conversation file path from a handoffPath + sessionId. */
export function conversationPathFor(handoffPath: string, sessionId: string): string {
  // handoffPath = <sessionDir>/handoffs/<file>
  const handoffsDir = path.dirname(handoffPath);
  const sessionDir = path.dirname(handoffsDir);
  return path.join(sessionDir, "conversations", `${sessionId}.jsonl`);
}

/** Append one message to the conversation file. Creates the directory if needed. */
export function appendMessage(filePath: string, message: Message): void {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    appendFileSync(filePath, JSON.stringify(message) + "\n");
  } catch (err) {
    log.warn("failed to append conversation message", { filePath, error: errorMessage(err) });
  }
}

/** Load prior messages from a conversation file. Returns empty array if missing or unreadable. */
export function loadMessages(filePath: string): Message[] {
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    return lines.map((line) => JSON.parse(line) as Message);
  } catch (err) {
    log.warn("failed to load conversation messages", { filePath, error: errorMessage(err) });
    return [];
  }
}
