import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store";
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStore } from "../../../../src/infra/event-store-types";
import { resolveEventStoreDbFile } from "../../../../src/infra/paths";
import type { ConversationMessage } from "../../../../src/orchestration/agent-runtime/llm/types";
import { createSessionManager } from "../../../../src/orchestration/session/manager";
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle";
import type { ConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree";
import type { ConversationEntry, MessageEntry } from "../../../../src/orchestration/session/conversation/conversation-entry-types";

export interface SavePointTestContext {
  baseDir: string;
  sessionId: string;
  conversationId: string;
  tree: ConversationTree;
  store: EventStore;
}

export async function createSavePointContext(): Promise<SavePointTestContext> {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-save-point-"));
  const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir));
  const mgr = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store });
  const sessionId = await mgr.createChat({ name: "Chat" });
  const conversationId = (await mgr.listMetadata()).sessions.find((s) => s.id === sessionId)?.conversationId ?? "";
  const tree = await tryOpenConversationTree({
    conversationId,
    sessionId,
    store: asAsyncEventReadSurface(store),
    writer: asAsyncEventWriter(store),
  });
  if (!tree) throw new Error(`expected conversation tree ${conversationId}`);
  return { baseDir, sessionId, conversationId, tree, store };
}

export async function disposeSavePointContext(ctx: SavePointTestContext): Promise<void> {
  await ctx.tree.getStorage().dispose();
  ctx.store.close();
  fs.rmSync(ctx.baseDir, { recursive: true, force: true });
}

export function userMessage(text: string): ConversationMessage {
  return { kind: "user", content: text };
}

export function assistantMessage(text: string): ConversationMessage {
  return { kind: "assistant", content: [{ type: "text", text }] };
}

export function assistantToolUseMessage(...ids: string[]): ConversationMessage {
  return {
    kind: "assistant",
    content: ids.map((id, index) => ({
      type: "tool_use",
      id,
      name: "search",
      input: { pattern: `query-${index + 1}` },
    })),
  };
}

export function toolResultMessage(toolUseId: string, content: string): ConversationMessage {
  return { kind: "toolResult", toolUseId, content: [{ type: "text", text: content }] };
}

export function toolResultMessages(results: ReadonlyArray<readonly [toolUseId: string, content: string]>): ConversationMessage[] {
  return results.map(([toolUseId, content]) => toolResultMessage(toolUseId, content));
}

export async function readEntries(tree: ConversationTree): Promise<ConversationEntry[]> {
  return tree.getBranch();
}

export function messageContent(entry: ConversationEntry | undefined): MessageEntry["message"] | undefined {
  if (!entry || entry.kind !== "message") return undefined;
  return entry.message;
}

/** A process that attaches to the session and rebuilds context from the store
 *  alone, exactly as reactivation does. It never saw the turn being written. */
export async function attachingProcess(ctx: SavePointTestContext): Promise<ConversationTree> {
  const fresh = await tryOpenConversationTree({ conversationId: ctx.conversationId, sessionId: ctx.sessionId, store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store) });
  if (!fresh) throw new Error(`expected conversation tree ${ctx.conversationId}`);
  return fresh;
}
