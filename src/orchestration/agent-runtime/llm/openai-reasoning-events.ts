import type { ResponseReasoningItem } from "openai/resources/responses/responses.js";
import type { ProviderStreamEvent } from "./types.js";

export function* yieldOpenAIReasoningItem(
  item: { type?: string },
  capturedReasoningIds: Set<string>,
  /** The provisional key the item's summary streamed under. */
  blockKey: string,
): Generator<ProviderStreamEvent> {
  if (item.type !== "reasoning") return;
  // SAFETY: callers pass items under the erased `{ type?: string }` contract that
  // decouples this helper from the full SDK output-item union; once type === "reasoning"
  // the item is the SDK's ResponseReasoningItem, restored here at the erasure seam.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: restore the SDK reasoning member after discriminant erasure
  const reasoning = item as ResponseReasoningItem;
  if (!reasoning.id || !reasoning.encrypted_content || capturedReasoningIds.has(reasoning.id)) return;
  capturedReasoningIds.add(reasoning.id);
  const event: Extract<ProviderStreamEvent, { kind: "reasoning" }> = {
    kind: "reasoning",
    id: reasoning.id,
    encryptedContent: reasoning.encrypted_content,
    ...(reasoning.summary ? { summary: reasoning.summary } : {}),
    blockKey,
  };
  yield event;
}
