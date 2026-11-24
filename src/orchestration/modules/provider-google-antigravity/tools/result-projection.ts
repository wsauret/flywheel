import type { CapabilityCheck } from "../../../../infra/capability-text.js"
import { limitOutput, savedOutputNotice } from "../../../agent-runtime/tools/truncation.js"
import type { LlmToolOutputPart } from "../../../agent-runtime/llm/messages.js"

// agy puts a `Created At: <time>\nCompleted At: <time>\n` envelope (78 bytes) before every tool result, and cuts a
// result whose text blocks, joined with "\n", and envelope exceed 10,240 characters to a preview and a file that only
// agy can read (agy 1.5.14, no setting). Flywheel keeps every result that it delivers, envelope included, within
// 10,000 bytes, so agy never cuts one.
const ENGINE_RESULT_BYTES = 10_000
const ENGINE_RESULT_ENVELOPE_BYTES = 78

/** The largest tool result text, in UTF-8 bytes, that the Google Antigravity route delivers to the model unchanged:
 *  the route's `ServingAttempt.toolResultWireBytes`. */
export const TOOL_RESULT_WIRE_BYTES = ENGINE_RESULT_BYTES - ENGINE_RESULT_ENVELOPE_BYTES

/** Where a cut result's full text is saved, and who reads the notice that names it (`limitOutput`). */
export interface ResultArtifactContext {
  readonly executionCwd: string
  readonly projectRoot: string
  readonly artifactScopeId: string
  /** The tool that produced the result, which names the saved file. */
  readonly toolName: string
  /** The agent check of the agent that reads the result. */
  readonly capabilities?: CapabilityCheck
  /** The file that Flywheel's own cut of this result saved its full text to: the call's recorded
   *  `ToolOutputRecovery.fullContentPath`. Absent when Flywheel kept the result whole or could not save it. */
  readonly savedOutputPath?: string
}

/**
 * The copy of the canonical tool result `content` that Flywheel's MCP server returns to agy. A result whose text, its
 * text parts joined with "\n", fits `TOOL_RESULT_WIRE_BYTES` is returned unchanged. A longer one becomes one text
 * part with its head and tail and the recovery notice of `limitOutput`, which names a saved file with the full text
 * that Flywheel's own tools read. That file is `context.savedOutputPath` when Flywheel's own cut saved one: its notice
 * leaves the kept text, so the copy names the file once, and no second file is written. Otherwise the whole text is
 * saved to a new file, and when that save fails, the notice states that the full output was not saved. Image parts
 * follow the text unchanged. Canonical history keeps `content`; only the engine's copy is cut.
 */
export async function projectToolResult(content: readonly LlmToolOutputPart[], context: ResultArtifactContext): Promise<readonly LlmToolOutputPart[]> {
  if (fitsEngineWire(content)) return content
  const { savedOutputPath, ...artifacts } = context
  const notice = savedOutputPath === undefined ? undefined : savedOutputNotice(savedOutputPath, context.executionCwd, context.capabilities)
  // Flywheel's cut ends a text part with the notice; parts after that part, such as a budget trailer, stay.
  const kept = notice === undefined ? content : content.map((part) => part.type === "text" && part.text.endsWith(notice) ? { ...part, text: part.text.slice(0, -notice.length).replace(/\n$/u, "") } : part)
  const limited = await limitOutput({
    ...artifacts,
    content: joinText(kept),
    ...savedOutputPath === undefined ? {} : { retainedFullContent: { path: savedOutputPath } },
    maxBytes: TOOL_RESULT_WIRE_BYTES,
  })
  return [{ type: "text", text: limited.text }, ...content.filter((part) => part.type === "image")]
}

/** Whether the engine reads the tool result `content` unchanged (`projectToolResult`). */
export function fitsEngineWire(content: readonly LlmToolOutputPart[]): boolean {
  return Buffer.byteLength(joinText(content), "utf8") <= TOOL_RESULT_WIRE_BYTES
}

function joinText(content: readonly LlmToolOutputPart[]): string {
  return content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")
}
