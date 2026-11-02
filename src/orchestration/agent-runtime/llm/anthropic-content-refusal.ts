import Anthropic from "@anthropic-ai/sdk";
import type { RefusedPart } from "../../../infra/llm/content-repair.js";
import { isRecord } from "../../../infra/record.js";
import type { AnthropicWireMessage } from "./anthropic-adapter-helpers.js";
import { anthropicToolResultParts, type BlockOrigins } from "./conversions/anthropic-messages.js";
import { ContentRefusedError } from "./errors.js";
import type { ConversationMessage } from "./types.js";

/** The message and block of the prepared request that the provider's request holds at wire message `wireMessage`,
 *  block `wireBlock`, or undefined when no prepared block is at that position. `prepared` is the origin of each block
 *  of the prepared messages (`PreparedAnthropicRequest.origins`). */
export type PreparedBlockLocation = (prepared: BlockOrigins, wireMessage: number, wireBlock: number) => { readonly message: number; readonly block: number } | undefined;

/** The provider's path to one tool result part, which Anthropic puts before the reason of a refusal (probe d1:
 *  `messages.3.content.1.tool_result.content.1.image.source.base64: The image was specified ...`). */
const TOOL_RESULT_PART_PATH = /^messages\.(\d+)\.content\.(\d+)\.tool_result\.content\.(\d+)\.(text|image)\b/;
const LEADING_PATH = /^messages\.[^\s:]*:\s*/;

/**
 * Returns a ContentRefusedError for a content refusal, with `part` set when the named wire part resolves to a
 * canonical tool result part of the kind that the error names; returns `error` unchanged for every other error.
 * A content refusal is an `invalid_request_error` whose message starts with a `messages.` path or names an image
 * (probe d3: `Could not process image`). The returned error keeps `error` as its cause, so the failure text that the
 * person reads does not change.
 *
 * `thrown` is what the provider failed with: an SDK error or the error of a stream error frame. `request` holds the request as it was prepared: `wireMessages` are its
 * messages, `canonicalMessages` the history that they were converted from, `wireIds` the converter's map from each
 * canonical tool call id to its wire id, `wireOrigins` the origin of each block of `wireMessages`, and `preparedBlock`
 * the route's map from a wire position to a prepared one (absent: the prepared messages are the wire).
 */
export function anthropicContentRefusal(error: Error, thrown: unknown, request: {
  readonly wireMessages: readonly AnthropicWireMessage[];
  readonly canonicalMessages: readonly ConversationMessage[];
  readonly wireIds: ReadonlyMap<string, string>;
  readonly wireOrigins: BlockOrigins;
  readonly supportsImages: boolean;
  readonly preparedBlock?: PreparedBlockLocation;
}): Error {
  const refused = anthropicErrorBody(thrown);
  if (refused?.type !== "invalid_request_error") return error;
  if (!/^messages\.\d/.test(refused.message) && !/\bimages?\b/i.test(refused.message)) return error;
  return new ContentRefusedError("Anthropic", error, { reason: refused.message.replace(LEADING_PATH, ""), part: refusedPart(refused.message, request) });
}

/** The `type` and `message` of an Anthropic error body, read from an SDK error or a stream error frame. */
function anthropicErrorBody(value: unknown): { type: string; message: string } | undefined {
  const body = value instanceof Anthropic.APIError && isRecord(value.error) ? value.error.error : value;
  return isRecord(body) && typeof body.type === "string" && typeof body.message === "string" ? { type: body.type, message: body.message } : undefined;
}

function refusedPart(message: string, request: Parameters<typeof anthropicContentRefusal>[2]): RefusedPart | undefined {
  const path = TOOL_RESULT_PART_PATH.exec(message);
  if (path === null) return undefined;
  const [, wireMessage, wireBlock, wirePart, named] = path.map(String);
  const kind = named === "text" ? "text" : "image";
  const part = Number(wirePart);
  const at = request.preparedBlock === undefined
    ? { message: Number(wireMessage), block: Number(wireBlock) }
    : request.preparedBlock(request.wireOrigins, Number(wireMessage), Number(wireBlock));
  if (at === undefined) return undefined;
  const content = request.wireMessages[at.message]?.content;
  const block = Array.isArray(content) ? content[at.block] : undefined;
  if (block?.type !== "tool_result" || !Array.isArray(block.content) || block.content[part]?.type !== kind) return undefined;
  const toolUseId = [...request.wireIds].find(([, wireId]) => wireId === block.tool_use_id)?.[0];
  const result = request.canonicalMessages.find((candidate) => candidate.kind === "toolResult" && candidate.toolUseId === toolUseId);
  if (toolUseId === undefined || result?.kind !== "toolResult") return undefined;
  const partIndex = anthropicToolResultParts(result, request.supportsImages)[part]?.partIndex;
  return partIndex !== undefined && result.content[partIndex]?.type === kind ? { toolUseId, partIndex, kind } : undefined;
}
