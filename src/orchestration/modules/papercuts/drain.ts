import type { AsyncEventReadSurface } from "../../../infra/event-store-types.js"
import { createBudgetProjection } from "../../session/budget-projection.js"
import { createPapercutBacklogProjection } from "./backlog.js"

const OUTPUT_RESERVE_TOKENS = 16_384
const CHARS_PER_TOKEN = 4

export type PapercutDrain =
  | { readonly kind: "ready"; readonly context: string }
  | { readonly kind: "no-live"; readonly message: string }
  | { readonly kind: "over-capacity"; readonly message: string }

/** Reads a captured complete project backlog and builds one request-only survey. It never truncates records. */
export async function buildPapercutDrain(reader: AsyncEventReadSurface, sessionId: string): Promise<PapercutDrain> {
  const backlog = await createPapercutBacklogProjection(reader).replay()
  if (backlog.count === 0) return { kind: "no-live", message: "No live project papercuts to drain." }

  const records = backlog.live.map((entry) => JSON.stringify({
    id: entry.recordedFactId,
    category: entry.category ?? "uncategorized",
    observation: entry.observation,
    source: {
      session: entry.owningSessionId,
      conversation: entry.conversationId,
      request: entry.modelRequestId,
      tool: entry.toolUseId,
      ...(entry.parentToolUseId ? { parent: entry.parentToolUseId } : {}),
    },
  }))
  const context = [
    "The user invoked /papercuts. Treat this captured backlog as the complete campaign scope for this run.",
    "Vet every record against current repository evidence. Judge the underlying pain, not the recorded suggestion or exact implementation.",
    "Inspect the repository and relevant executable evidence. Use bounded subagents when independent or noisy investigations justify their coordination cost.",
    "Judge whether each valid record is worth fixing. It is not when its pain is minor, or when it records a mistake by the agent that logged it and Flywheel's prompts, tool descriptions, and documentation neither misled that agent nor failed to explain the correct path. Before you skip an agent mistake, check that guidance: when it misled the agent or left the correct path unexplained, the guidance is the defect to fix.",
    "Immediately dispose records after vetting: fixed when current evidence shows the pain is gone; dismissed when the record is stale, duplicate, invalid, irrelevant, outside scope, or not worth fixing, with the reason. Keep one representative of a duplicate group live until its shared pain is verified as fixed.",
    "Investigate every remaining record enough to identify its root cause and delivery size. Group the remaining records by root cause, including every source record id in its unit.",
    "Present one ordered campaign map. In the same response, present the complete design for the highest-priority unit and ask for approval through the normal design method. Do not implement before approval.",
    "After each approved unit, implement through the route its design selects, review and verify the result, then dispose every satisfied source record as fixed. Continue through one approved unit at a time until this captured backlog is resolved or the user explicitly defers the remaining work.",
    "Do not create plan Markdown files for the backlog. Leave deferred records live. Never use the promoted disposition because it has no durable successor owner.",
    ...records,
  ].join("\n")

  const { contextPromptTokens, contextWindow } = await createBudgetProjection(reader, sessionId).replay()
  const serializedSurveyTokens = Math.ceil(context.length / CHARS_PER_TOKEN)
  if (contextWindow > 0 && contextPromptTokens + serializedSurveyTokens + OUTPUT_RESERVE_TOKENS > contextWindow) {
    return { kind: "over-capacity", message: "The complete papercut survey does not fit this chat's selected attempt context limit. Open a fresh chat and drain again." }
  }
  return { kind: "ready", context }
}
