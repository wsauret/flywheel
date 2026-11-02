import { dirname, join } from "node:path";
import { sessionScratchDir } from "../../infra/paths.js";

/** Disposable scratch and the legacy note location used only for checkpoint conversion. */
export interface ConversationResources {
  readonly scratchDir?: string;
  readonly notesDirectory?: string;
}

/** Resolves paths without creating files. Reviews and imported conversations retain
 * their old note keys for lossless first-use conversion. */
export function resolveConversationResources(
  sessionDir: string | undefined,
  conversationId?: string,
  reviewRunId?: string,
  imported?: { readonly workflowId: string; readonly conversationId: string },
): ConversationResources {
  if (!sessionDir) return {};
  const scratchDir = sessionScratchDir(imported ? join(dirname(sessionDir), imported.workflowId) : sessionDir);
  const notesKey = reviewRunId ?? imported?.conversationId ?? conversationId;
  if (!notesKey) return { scratchDir };
  const identity = Buffer.from(notesKey, "utf8").toString("hex");
  return { scratchDir, notesDirectory: join(scratchDir, "notes", identity) };
}
