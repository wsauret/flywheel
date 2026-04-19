/**
 * Conversation persistence for the harness engine.
 *
 * Two files per engine session:
 *   `<sessionDir>/conversations/<engineSessionId>.jsonl`  — message history
 *   `<sessionDir>/conversations/<engineSessionId>.meta.json` — session metadata
 *
 * Messages stream to disk via appendMessage as they're produced.
 * Metadata is saved once when the agent loop completes.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Log } from "../../../../infra/log.js";
import { errorMessage } from "../../../../infra/error-message.js";
import type { Message } from "./llm/types.js";

const log = Log.create({ service: "harness-conversation-store" });

export interface ConversationMeta {
  previousResponseId?: string;
}

export function conversationPathFor(sessionDir: string, engineSessionId: string): string {
  return path.join(sessionDir, "conversations", `${engineSessionId}.jsonl`);
}

function metaPathFor(sessionDir: string, engineSessionId: string): string {
  return path.join(sessionDir, "conversations", `${engineSessionId}.meta.json`);
}

export function appendMessage(filePath: string, message: Message): void {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    appendFileSync(filePath, JSON.stringify(message) + "\n");
  } catch (err) {
    log.warn("failed to append conversation message", { filePath, error: errorMessage(err) });
  }
}

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

export function saveMeta(sessionDir: string, engineSessionId: string, meta: ConversationMeta): void {
  const filePath = metaPathFor(sessionDir, engineSessionId);
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(meta) + "\n");
  } catch (err) {
    log.warn("failed to save conversation metadata", { filePath, error: errorMessage(err) });
  }
}

export function loadMeta(sessionDir: string, engineSessionId: string): ConversationMeta | null {
  const filePath = metaPathFor(sessionDir, engineSessionId);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as ConversationMeta;
  } catch (err) {
    log.warn("failed to load conversation metadata", { filePath, error: errorMessage(err) });
    return null;
  }
}
