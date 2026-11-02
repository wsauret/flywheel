import { offeringTransport, type CatalogJsonValue } from "./model-catalog-resolution.js";

/** OpenCode Go is a flat-rate subscription that serves a rotating set of
 * open frontier models under their plan-native bare ids.
 *
 * Each entry is pinned to a wire verified live:
 *
 * - "openai-completions": chat-completions wire; reasoning streams on
 *   `reasoning_content`. glm-5.3 lives here because the plan's messages
 *   endpoint rejects it live, despite the plan docs listing it there.
 * - "anthropic-messages": qwen ids. They need the adaptive thinking shape;
 *   the budget-token shape 400s on qwen3.8-max (model-compat.ts).
 * - "openai-responses": Responses wire with effort-tier reasoning. */
export type OpencodeGoEndpoint = "anthropic-messages" | "openai-responses" | "openai-completions";

/** OpenCode Go uses chat completions unless models.dev names a native transport. */
export function opencodeGoEndpointForMetadata(metadata: CatalogJsonValue | undefined): OpencodeGoEndpoint {
  const transport = metadata === undefined ? undefined : offeringTransport(metadata);
  return transport === "anthropic-messages" || transport === "openai-responses" || transport === "openai-completions"
    ? transport
    : "openai-completions";
}

