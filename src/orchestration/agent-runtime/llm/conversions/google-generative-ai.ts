/**
 * Convert canonical ConversationMessage[] history to Google Generative AI Content[].
 *
 * Google models cannot replay another provider's `thoughtSignature` blocks, and
 * tool result messages ride inside `functionResponse` parts of a synthetic "user"
 * Content rather than as a separate role.
 */

import type { Content, Part } from "@google/genai";
import { imageOmittedPlaceholder, splitToolOutputParts } from "../../../../infra/llm/tool-output-part-schema.js";
import type { AccessProviderId } from "../../../../infra/llm/access-provider.js";
import { healConversation } from "../heal-messages.js";
import { lowerProviderHistory, type ProviderHistoryTarget } from "../provider-history.js";
import { isSameProviderReplay } from "../messages.js"
import type { ModelFamily } from "../../../../infra/llm/model-family.js";
import type { ContentBlock, ConversationMessage } from "../types.js";
import { sanitizeSurrogates } from "../sanitize-unicode.js";

interface GoogleGenerativeAiConversionOptions {
  accessProvider: AccessProviderId;
  /** Access provider, provider family, and model of the adapter doing the call,
   * used to decide whether opaque signatures can be replayed. */
  provider: ModelFamily;
  model: string;
  supportsImages?: boolean;
}

const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;
// Signature bytes are Gemini-authored, stored verbatim; validate before replay because a corrupt value 400s the whole request.
function isValidThoughtSignature(signature: string | undefined): boolean {
  if (!signature) return false;
  if (signature.length % 4 !== 0) return false;
  return base64SignaturePattern.test(signature);
}

function requiresToolCallId(modelId: string): boolean {
  // Models routed through Google APIs that require explicit function-call IDs.
  return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-"); // provider-model-literal-allow: payload -- Google tool-call ID wire compatibility
}

function normalizeToolCallId(modelId: string, id: string): string {
  if (!requiresToolCallId(modelId)) return id;
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function contentBlocks(content: string | ContentBlock[]): ContentBlock[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

function convertUser(content: string | ContentBlock[], supportsImages: boolean): Part[] {
  const parts: Part[] = [];
  for (const block of contentBlocks(content)) {
    if (block.type === "text") parts.push({ text: sanitizeSurrogates(block.text) });
    else if (block.type === "image") {
      // Non-vision models reject inlineData parts; the placeholder tells the
      // model an image was present (same contract as the other converters).
      if (supportsImages) parts.push({ inlineData: { mimeType: block.mediaType, data: block.data } });
      else parts.push({ text: imageOmittedPlaceholder(block.mediaType) });
    }
  }
  return parts;
}

/** Gemini 3+ accepts images nested inside `functionResponse.parts`; older
 *  Gemini majors and non-Gemini models served through Google APIs need a
 *  separate labeled user turn instead (pi
 *  `google-shared.ts:75-87`). Unversioned ids default to the modern shape. */
function supportsMultimodalFunctionResponse(modelId: string): boolean {
  const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/); // provider-model-literal-allow: payload -- Google multimodal response wire compatibility
  if (!match?.[1]) return true;
  return Number.parseInt(match[1], 10) >= 3;
}

function convertAssistantBlock(
  block: ContentBlock,
  sameProvider: boolean,
  modelId: string,
): Part | undefined {
  if (block.type === "text" && block.text.trim()) {
    const sig = sameProvider && isValidThoughtSignature(block.signature) ? block.signature : undefined;
    return { text: sanitizeSurrogates(block.text), ...(sig && { thoughtSignature: sig }) };
  }
  // Lowering left thinking only on this target's own turns (`lowerProviderHistory`).
  if (block.type === "thinking" && block.thinking.trim() && !block.redacted && sameProvider) {
    const sig = isValidThoughtSignature(block.signature) ? block.signature : undefined;
    return { thought: true, text: sanitizeSurrogates(block.thinking), ...(sig && { thoughtSignature: sig }) };
  }
  if (block.type === "tool_use") {
    const sig = sameProvider && isValidThoughtSignature(block.thoughtSignature) ? block.thoughtSignature : undefined;
    return {
      functionCall: {
        name: block.name,
        args: block.input,
        ...(requiresToolCallId(modelId) ? { id: normalizeToolCallId(modelId, block.id) } : {}),
      },
      ...(sig && { thoughtSignature: sig }),
    };
  }
  return undefined;
}

/** Converts history[start..] tool results until the run ends, returning the
 *  index of the first message after the run. All function responses of the
 *  run land in one user turn (Cloud Code Assist requires it). Images never
 *  ride as siblings of the functionResponse part: Gemini 3+ nests them inside
 *  `functionResponse.parts`, and older models take one labeled user turn after
 *  the run (pi `google-shared.ts:81-87,:188-231`). */
function appendToolResultRun(
  contents: Content[],
  history: readonly ConversationMessage[],
  start: number,
  toolNamesById: ReadonlyMap<string, string>,
  modelId: string,
  supportsImages: boolean,
): number {
  const nestImages = supportsMultimodalFunctionResponse(modelId);
  const fnParts: Part[] = [];
  const trailingImages: Part[] = [];
  let index = start;
  while (index < history.length) {
    const message = history[index];
    if (message?.kind !== "toolResult") break;
    const split = splitToolOutputParts(message.content, supportsImages);
    const textChunks = split.text ? [split.text] : [];
    if (split.omittedImagePlaceholders.length > 0) textChunks.push(...split.omittedImagePlaceholders);
    const imageParts: Part[] = split.images.map((p) => ({ inlineData: { mimeType: p.mediaType, data: p.data } }));
    const hasImages = imageParts.length > 0;
    const text = sanitizeSurrogates(textChunks.join("\n"));
    // An image-only result still needs a textual response value; the placeholder
    // points the model at the attached image (pi `google-shared.ts:194`).
    const textOutput = text.length > 0 ? text : hasImages ? "(see attached image)" : "";
    fnParts.push({
      functionResponse: {
        // Use the originating tool name when known (resolved from the matching
        // tool_use block). Falls back to "tool" for results whose call is gone.
        name: toolNamesById.get(message.toolUseId) ?? "tool",
        response: message.isError === true ? { error: textOutput } : { output: textOutput },
        ...(hasImages && nestImages ? { parts: imageParts } : {}),
        ...(requiresToolCallId(modelId) ? { id: normalizeToolCallId(modelId, message.toolUseId) } : {}),
      },
    });
    if (hasImages && !nestImages) trailingImages.push(...imageParts);
    index += 1;
  }
  const last = contents[contents.length - 1];
  if (last?.role === "user" && last.parts?.some((p) => p.functionResponse)) {
    last.parts.push(...fnParts);
  } else {
    contents.push({ role: "user", parts: fnParts });
  }
  if (trailingImages.length > 0) {
    contents.push({ role: "user", parts: [{ text: "Tool result image:" }, ...trailingImages] });
  }
  return index;
}

// Google's `functionResponse.name` requires the originating tool's name, which
// lives on the matching `tool_use` block of a prior assistant message.
function collectToolNames(history: readonly ConversationMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of history) {
    if (message.kind !== "assistant" || typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type === "tool_use") names.set(block.id, block.name);
    }
  }
  return names;
}

/** The replay identity that the Google adapter stamps on its turns and lowers history for. */
export function googleHistoryTarget(options: Pick<GoogleGenerativeAiConversionOptions, "accessProvider" | "model">): ProviderHistoryTarget {
  return { accessProvider: options.accessProvider, provider: "google", api: "google-generative-ai", model: options.model, sharedHost: false };
}

export function toGoogleGenerativeAiRequest(
  options: GoogleGenerativeAiConversionOptions,
  rawHistory: ConversationMessage[],
): Content[] {
  const supportsImages = options.supportsImages !== false;
  const target = googleHistoryTarget(options);
  const history = lowerProviderHistory(healConversation(rawHistory), target);
  const toolNamesById = collectToolNames(history);
  const contents: Content[] = [];
  let index = 0;
  while (index < history.length) {
    const message = history[index];
    if (!message) break;
    if (message.kind === "toolResult") {
      index = appendToolResultRun(contents, history, index, toolNamesById, options.model, supportsImages);
      continue;
    }
    if (message.kind === "user" || message.kind === "compactionSummary") {
      const parts = convertUser(message.content, supportsImages);
      if (parts.length) contents.push({ role: "user", parts });
    } else if (message.kind === "assistant") {
      const sameProvider = isSameProviderReplay(message, target);
      const parts = contentBlocks(message.content)
        .map((b) => convertAssistantBlock(b, sameProvider, options.model))
        .filter((p): p is Part => p !== undefined);
      if (parts.length) contents.push({ role: "model", parts });
    }
    index += 1;
  }
  return contents;
}
