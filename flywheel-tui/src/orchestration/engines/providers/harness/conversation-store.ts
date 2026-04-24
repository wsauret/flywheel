/**
 * Conversation persistence for the harness engine.
 *
 * Two files per engine session:
 *   `<sessionDir>/conversations/<engineSessionId>.jsonl`  — message history
 *   `<sessionDir>/conversations/<engineSessionId>.meta.json` — session metadata
 *
 * Each new message is appended as a single line. Full rewrites happen only
 * when the messages array is replaced wholesale (e.g. after compaction) or
 * when the trailing user message is merged into in place. The on-disk log
 * still matches the in-memory `messages` array — no append/splice divergence,
 * no orphan tool_use entries after compaction.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Log } from "../../../../infra/log.js";
import { errorMessage } from "../../../../infra/error-message.js";
import type { Message } from "./llm/types.js";

const log = Log.create({ service: "harness-conversation-store" });

interface ConversationMeta {
  previousResponseId?: string;
}

export function conversationPathFor(sessionDir: string, engineSessionId: string): string {
  return path.join(sessionDir, "conversations", `${engineSessionId}.jsonl`);
}

function metaPathFor(sessionDir: string, engineSessionId: string): string {
  return path.join(sessionDir, "conversations", `${engineSessionId}.meta.json`);
}

export function rewriteMessages(filePath: string, messages: ReadonlyArray<Message>): void {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const body = messages.length === 0
      ? ""
      : messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    writeFileSync(filePath, body);
  } catch (err) {
    log.warn("failed to rewrite conversation messages", { filePath, error: errorMessage(err) });
  }
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
    const raw = lines.map((line) => JSON.parse(line) as Message);
    const sanitized = sanitize(raw);
    if (sanitized.length < raw.length) {
      log.warn("truncated conversation log on load — orphan tool_use block", {
        filePath,
        original: raw.length,
        kept: sanitized.length,
      });
      rewriteMessages(filePath, sanitized);
    }
    return sanitized;
  } catch (err) {
    log.warn("failed to load conversation messages", { filePath, error: errorMessage(err) });
    return [];
  }
}

/** Truncate at the first assistant(tool_use) not immediately followed by a
 *  user message containing matching tool_result blocks. Heals conversation
 *  logs written by earlier builds that could leave dangling tool_use entries. */
function sanitize(messages: ReadonlyArray<Message>): Message[] {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    const toolUseIds: string[] = [];
    for (const b of m.content) if (b.type === "tool_use") toolUseIds.push(b.id);
    if (toolUseIds.length === 0) continue;

    const next = messages[i + 1];
    if (!next || next.role !== "user" || typeof next.content === "string") {
      return messages.slice(0, i);
    }
    const resultIds = new Set<string>();
    for (const b of next.content) if (b.type === "tool_result") resultIds.add(b.tool_use_id);
    for (const id of toolUseIds) {
      if (!resultIds.has(id)) return messages.slice(0, i);
    }
  }
  return [...messages];
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
