import { papercutDispositionRuntime, type PapercutDispositionWriter } from "./disposition-writer.js"
import type { PapercutRecordedFact } from "./facts.js"
import type { RuntimeTool, RuntimeToolInput, ToolContext, ToolResult } from "../../agent-runtime/tools/types.js"

const CATEGORIES = ["defect", "flaky", "docs-drift", "missing-tooling"] as const
const DISPOSITIONS = ["fixed", "dismissed"] as const

export const papercutLogDefinition: RuntimeTool = {
  name: "papercut_log",
  action: "ui_meta",
  description: "Record one or two sentences about a papercut in the open repository's code, docs, tests, or build tooling, including request-shaped missing tooling, docs, and fixtures. Never record friction in your own agent definitions or tools here, and report runtime bugs as user-visible failures.",
  inputSchema: {
    type: "object",
    properties: {
      observation: { type: "string", minLength: 1, description: "One or two sentences that describe the observed papercut." },
      category: { type: "string", enum: CATEGORIES },
    },
    required: ["observation"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  execute: recordPapercut,
}

async function recordPapercut(input: RuntimeToolInput, context: ToolContext): Promise<ToolResult> {
  const observation = nonEmptyString(input.observation)
  const category = optionalMember(input.category, CATEGORIES)
  const writer = context.sessionEventWriter
  const conversationId = nonEmptyString(context.conversationId)
  const modelRequestId = nonEmptyString(context.modelRequestId)
  const toolUseId = nonEmptyString(context.toolUseId)
  const parentToolUseId = nonEmptyString(context.parentToolUseId)
  if (!observation || input.category !== undefined && !category) return failure("Papercut input was invalid.")
  if (!writer || !conversationId || !modelRequestId || !toolUseId) return failure("Papercut recording has no complete runtime ownership context.")

  const fact: PapercutRecordedFact = {
    type: "papercut.recorded",
    version: 1,
    actor: "agent",
    payload: {
      observation,
      ...(category ? { category } : {}),
      conversationId,
      modelRequestId,
      toolUseId,
      ...(parentToolUseId ? { parentToolUseId } : {}),
    },
  }
  await writer.record(fact)
  return { content: "Papercut recorded.", outcome: "ok" }
}

export function createPapercutDisposeTool(writer: PapercutDispositionWriter): RuntimeTool {
  return {
    name: "papercut_dispose",
    action: "ui_meta",
    description: "Atomically close one live project papercut as fixed when evidence shows the pain is gone, or dismissed when the record is no longer actionable.",
    inputSchema: {
      type: "object",
      properties: {
        recorded_fact_id: { type: "string", minLength: 1 },
        disposition: { type: "string", enum: DISPOSITIONS },
      },
      required: ["recorded_fact_id", "disposition"],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
    execute: async (input, context) => disposePapercut(writer, input, context),
  }
}

async function disposePapercut(writer: PapercutDispositionWriter, input: RuntimeToolInput, context: ToolContext): Promise<ToolResult> {
  const recordedFactId = nonEmptyString(input.recorded_fact_id)
  const disposition = optionalMember(input.disposition, DISPOSITIONS)
  if (!recordedFactId || !disposition) return failure("Papercut disposition input was invalid.")
  if (!context.sessionId) return failure("This runtime names no session, so the papercut cannot be disposed.")
  const result = await writer.dispose({ recordedFactId, disposition, disposingSessionId: context.sessionId })
  return { content: result.kind === "disposed" ? "Papercut disposed." : "Papercut was already disposed.", outcome: "ok" }
}

export const papercutDisposeDefinition: RuntimeTool = {
  ...createPapercutDisposeTool({
    dispose: async (input) => {
      throw new Error(`Papercut disposition writer is not bound for ${input.recordedFactId}`)
    },
  }),
  execute: async (input, context) => {
    const writer = context.moduleRuntimes?.get(papercutDispositionRuntime)
    if (!writer) return failure("Papercut disposition has no runtime writer.")
    return disposePapercut(writer, input, context)
  },
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function optionalMember<const Values extends readonly string[]>(value: unknown, values: Values): Values[number] | undefined {
  return typeof value === "string" ? values.find((entry) => entry === value) : undefined
}

function failure(detail: string): ToolResult {
  return { content: `${detail} Tell the user that the runtime could not persist the papercut operation.`, outcome: "error" }
}
