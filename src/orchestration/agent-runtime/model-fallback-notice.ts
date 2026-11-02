import { errorMessage } from "../../infra/error-message.js";
import { canonicalModelId } from "../../infra/llm/model-id.js";
import { Log } from "../../infra/log.js";
import { isModelTierReference } from "../../protocol/model-tier-reference.js";
import type { RuntimeConversation } from "./runtime-conversation.js";

const log = Log.create({ service: "model-fallback-notice" });

const SAVED = "The saved model, ";
const UNTIL = " serves this agent until it can.";

/** The model and effort that one request resolved, beside the authored model it resolved from. */
export interface RequestServingSelection {
  /** The model the role's setting names; undefined when the role has no saved model. */
  readonly saved: string | undefined;
  readonly model: string;
  readonly effort: string | undefined;
}

/**
 * Tells the person, in the agent's own transcript, when a request resolves
 * past the saved model to another one, and when the saved model serves
 * again, or the setting no longer names a model, which ends the condition
 * with the model that serves. Each row is a display-only system entry, so no
 * model reads it.
 * `onSystemMessage` shows a committed row in the live transcript, as a reopen
 * projects it. Returns undefined for a conversation without a durable tree,
 * which has no transcript to tell.
 *
 * The transcript itself is the record of what the person was told: rows take
 * the ids `model-fallback:<conversationId>:<n>` in order, and the newest row
 * is the condition in force. The first request of a runtime finds it with one
 * read of the committed tree; every later request compares against the row
 * this runtime holds, so a request reads nothing and writes only when the
 * condition changes. The notice is display-only, so it never fails the
 * request: a failed read or append records one warning, and the next request
 * reads the committed tree again.
 */
export function createModelFallbackNotice(
  conversation: Pick<RuntimeConversation, "sessionId" | "aggregateId" | "persistence">,
  onSystemMessage?: (message: string) => void,
): ((selection: RequestServingSelection) => Promise<void>) | undefined {
  const { sessionId, aggregateId: conversationId, persistence: { history, committedTree } } = conversation;
  if (conversationId === undefined || committedTree === undefined) return undefined;
  const entryId = (index: number) => `model-fallback:${conversationId}:${index}`;
  let latest: Promise<{ readonly index: number; readonly content: string | undefined }> | undefined;
  const newestRow = async () => {
    const { entriesById } = await committedTree();
    let content: string | undefined;
    for (let index = 0; ; index += 1) {
      const entry = entriesById[entryId(index)];
      if (entry?.kind !== "message" || entry.message.kind !== "system") return { index: index - 1, content };
      content = entry.message.content;
    }
  };
  return async (selection) => {
    try {
      const recorded = await (latest ??= newestRow());
      const content = nextRow(selection, recorded.content);
      if (content === undefined) return;
      const index = recorded.index + 1;
      await history.append({ kind: "system", content, displayOnly: true }, entryId(index));
      latest = Promise.resolve({ index, content });
      onSystemMessage?.(content);
      log.info("model fallback notice recorded", {
        sessionId, conversationId, entryId: entryId(index),
        condition: content.endsWith(UNTIL) ? "fallback" : content.startsWith(SAVED) ? "recovered" : "ended",
        savedModel: selection.saved, servingModel: selection.model, effort: selection.effort,
      });
    } catch (error) {
      latest = undefined;
      log.warn("model fallback notice failed", { sessionId, conversationId, savedModel: selection.saved, servingModel: selection.model, error: errorMessage(error) });
    }
  };
}

/** The row that states this selection after the newest row, or undefined when the newest row states it already.
 *  Only a fallback row opens the condition: a saved model that serves closes it by name, whether it recovered or the
 *  person saved another one, and a setting that names no concrete model closes it with the model that serves. */
function nextRow(selection: RequestServingSelection, newest: string | undefined): string | undefined {
  const { saved } = selection;
  const serving = selection.effort === undefined ? selection.model : `${selection.model} at ${selection.effort} effort`;
  const fallingBack = newest?.endsWith(UNTIL) === true;
  if (saved === undefined || isModelTierReference(saved)) return fallingBack ? `${serving} serves this agent.` : undefined;
  if (canonicalModelId(saved) === selection.model) return fallingBack ? `${SAVED}${saved}, serves this agent.` : undefined;
  const row = `${SAVED}${saved}, cannot serve now. ${serving}${UNTIL}`;
  return row === newest ? undefined : row;
}
