import type { BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { asRecord, type UnknownRecord } from "../../../infra/record.js";
import { parseAnthropicToolInput } from "../../agent-runtime/llm/anthropic-tool-input.js";
import type { CliBlock, CliMessage } from "./cli-view.js";

/**
 * What the bridge does with the query when a request ends.
 * - `park`: the CLI waits in the handlers of the message's tool calls.
 * - `idle`: the CLI waits for the next input.
 * - `stop`: interrupt at once. The CLI continues by itself after such a reply: a nudge after an empty, blank, or
 *   thinking-only reply, a resume after `max_tokens`, or an answer to an undeclared tool or to tool input that is
 *   not a JSON object. The step gate refuses the request of that continuation, but the CLI has then added its own
 *   messages to its history, so the query no longer matches canonical history. Every other stop reason also stops,
 *   so the next request starts a new query.
 */
type RequestSettlement = "park" | "idle" | "stop";

/** Each settlement rule and the settlement it decides, in the order that `settle` tests them. The first four match a
 *  block that the CLI answers by itself, whatever the stop reason; the rest read the stop reason and the blocks. */
const SETTLEMENT_RULES = {
  "undeclared-tool": "stop",
  "unread-block": "stop",
  "tool-input-not-json": "stop",
  "tool-input-not-object": "stop",
  "tool-calls": "park",
  "visible-answer": "idle",
  "tool-use-without-calls": "stop",
  "end-with-calls": "stop",
  "blank-answer": "stop",
  "other-stop-reason": "stop",
} as const satisfies { readonly [rule: string]: RequestSettlement };

type SettlementRule = keyof typeof SETTLEMENT_RULES;

/** The kinds and counts that one settlement read, for the bridge's stop record. It holds no content. */
export interface SettlementEvidence {
  readonly rule: SettlementRule;
  readonly stopReason: string;
  readonly blocks: { readonly text: number; readonly visibleText: number; readonly thinking: number; readonly redacted: number; readonly toolUse: number; readonly unread: number };
  readonly toolUses: {
    readonly declared: number;
    readonly undeclared: number;
    readonly objectInput: number;
    readonly inputNotJson: number;
    readonly inputNotObject: number;
    /** Rejected inputs that the shared Anthropic adapter reads into an object against the tool's schema. Flywheel
     *  runs such a call, while the CLI answers it by itself. */
    readonly inputRepairable: number;
  };
  /** The first block type that the shared adapter does not read. */
  readonly unreadBlockType?: string;
}

export type AssemblyStep =
  | { readonly kind: "continue" }
  /** The stop of a tool block whose input is not JSON, which the assembler holds. The CLI also closes an open block
   *  when the connection drops, so only a stop reason after it shows that the service sent it. */
  | { readonly kind: "hold" }
  /** The first `message_delta` with a stop reason ends the request (bridge rule 1). `held`: the block stops that the
   *  assembler held, which the bridge forwards before the stop reason. A cut drops them, as native never sees a
   *  block stop that the stream did not carry. */
  | { readonly kind: "end"; readonly settlement: RequestSettlement; readonly toolUseIds: readonly string[]; readonly evidence: SettlementEvidence; readonly held: readonly BetaRawMessageStreamEvent[] }
  /** A `message_stop` with no stop reason before it is the CLI's synthetic tail after a cut, an SSE error, or an
   *  interrupt. The request failed. */
  | { readonly kind: "cut" };

/** The token counts of one request, as the provider reported them last. */
interface AssistantUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

export interface AssistantAssembler {
  add(event: BetaRawMessageStreamEvent): AssemblyStep;
  /** The assistant message that the CLI holds, with thinking text and signatures byte for byte. */
  message(): CliMessage;
  usage(): AssistantUsage;
}

/** Why the CLI cannot hand a tool call's streamed input to its handler. */
type InputFault = "not-json" | "not-object";

type Slot =
  | { kind: "text"; text: string }
  | { kind: "thinking"; thinking: string; signature: string }
  | { kind: "redacted"; data: string }
  | { kind: "tool"; id: string; name: string; json: string; input: UnknownRecord; fault: InputFault | undefined };

/**
 * Builds the raw assistant message of one admitted request from its stream events. `declaredTools` maps each name by
 * which the query's CLI hands a call to a handler, each tool's MCP name and its alias, to the tool's input schema.
 * The message holds each tool input as the CLI parses it, so a CLI copy that differs from what Flywheel read starts a
 * new query from canonical history (`planRequest`).
 */
export function createAssistantAssembler(declaredTools: ReadonlyMap<string, unknown>): AssistantAssembler {
  const slots = new Map<number, Slot>();
  let unreadBlocks = 0;
  let unreadBlockType: string | undefined;
  let ended = false;
  const held: BetaRawMessageStreamEvent[] = [];
  let usage: AssistantUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const continuing: AssemblyStep = { kind: "continue" };
  const ordered = () => [...slots.entries()].toSorted(([a], [b]) => a - b).map(([, slot]) => slot);

  function settle(stopReason: string): AssemblyStep {
    ended = true;
    const blocks = ordered();
    const tools = blocks.filter((slot) => slot.kind === "tool");
    const texts = blocks.filter((slot) => slot.kind === "text");
    const visibleText = texts.filter((slot) => slot.text.trim() !== "").length;
    const count = (fault: InputFault) => tools.filter((slot) => slot.fault === fault).length;
    const toolUses = {
      declared: tools.filter((slot) => declaredTools.has(slot.name)).length,
      undeclared: tools.filter((slot) => !declaredTools.has(slot.name)).length,
      objectInput: tools.filter((slot) => slot.fault === undefined).length,
      inputNotJson: count("not-json"),
      inputNotObject: count("not-object"),
      inputRepairable: tools.filter((slot) => slot.fault !== undefined && parseAnthropicToolInput(slot.json, asRecord(declaredTools.get(slot.name))).parseError === undefined).length,
    };
    const answers = stopReason === "end_turn" || stopReason === "stop_sequence";
    const rule: SettlementRule = toolUses.undeclared > 0 ? "undeclared-tool"
      : unreadBlocks > 0 ? "unread-block"
      : toolUses.inputNotJson > 0 ? "tool-input-not-json"
      : toolUses.inputNotObject > 0 ? "tool-input-not-object"
      : stopReason === "tool_use" ? (tools.length > 0 ? "tool-calls" : "tool-use-without-calls")
      : !answers ? "other-stop-reason"
      : tools.length > 0 ? "end-with-calls"
      : visibleText > 0 ? "visible-answer"
      : "blank-answer";
    const evidence: SettlementEvidence = {
      rule, stopReason,
      blocks: {
        text: texts.length, visibleText, thinking: blocks.filter((slot) => slot.kind === "thinking").length,
        redacted: blocks.filter((slot) => slot.kind === "redacted").length, toolUse: tools.length, unread: unreadBlocks,
      },
      toolUses,
      ...(unreadBlockType === undefined ? {} : { unreadBlockType }),
    };
    return { kind: "end", settlement: SETTLEMENT_RULES[rule], toolUseIds: tools.map((slot) => slot.id), evidence, held };
  }

  return {
    add(event) {
      switch (event.type) {
        case "message_start": {
          const reported = event.message.usage;
          usage = {
            inputTokens: reported.input_tokens, outputTokens: reported.output_tokens,
            cacheReadTokens: reported.cache_read_input_tokens ?? 0, cacheCreationTokens: reported.cache_creation_input_tokens ?? 0,
          };
          return continuing;
        }
        case "content_block_start": {
          const block = event.content_block;
          if (block.type === "text") slots.set(event.index, { kind: "text", text: block.text });
          else if (block.type === "thinking") slots.set(event.index, { kind: "thinking", thinking: block.thinking, signature: block.signature });
          else if (block.type === "redacted_thinking") slots.set(event.index, { kind: "redacted", data: block.data });
          else if (block.type === "tool_use") slots.set(event.index, { kind: "tool", id: block.id, name: block.name, json: "", input: {}, fault: undefined });
          else {
            unreadBlocks += 1;
            unreadBlockType ??= block.type;
          }
          return continuing;
        }
        case "content_block_delta": {
          const slot = slots.get(event.index);
          const delta = event.delta;
          if (slot?.kind === "text" && delta.type === "text_delta") slot.text += delta.text;
          else if (slot?.kind === "thinking" && delta.type === "thinking_delta") slot.thinking += delta.thinking;
          else if (slot?.kind === "thinking" && delta.type === "signature_delta") slot.signature += delta.signature;
          else if (slot?.kind === "tool" && delta.type === "input_json_delta") slot.json += delta.partial_json;
          return continuing;
        }
        case "content_block_stop": {
          const slot = slots.get(event.index);
          if (slot?.kind === "tool") {
            const input = toolInput(slot.json);
            if (typeof input === "string") slot.fault = input;
            else slot.input = input;
            if (slot.fault === "not-json") {
              held.push(event);
              return { kind: "hold" };
            }
          }
          return continuing;
        }
        case "message_delta": {
          const reported = event.usage;
          usage = {
            inputTokens: reported.input_tokens ?? usage.inputTokens, outputTokens: reported.output_tokens,
            cacheReadTokens: reported.cache_read_input_tokens ?? usage.cacheReadTokens,
            cacheCreationTokens: reported.cache_creation_input_tokens ?? usage.cacheCreationTokens,
          };
          return !ended && event.delta.stop_reason !== null ? settle(event.delta.stop_reason) : continuing;
        }
        case "message_stop":
          return ended ? continuing : { kind: "cut" };
      }
    },
    message() {
      return { role: "assistant", content: ordered().map(cliBlock) };
    },
    usage: () => usage,
  };
}

/** The CLI parses the streamed input itself; anything other than a JSON object makes it answer the call alone. */
function toolInput(json: string): UnknownRecord | InputFault {
  if (json === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return "not-json";
  }
  return asRecord(parsed) ?? "not-object";
}

function cliBlock(slot: Slot): CliBlock {
  switch (slot.kind) {
    case "text": return { type: "text", text: slot.text };
    case "thinking": return { type: "thinking", thinking: slot.thinking, signature: slot.signature };
    case "redacted": return { type: "redacted_thinking", data: slot.data };
    case "tool": return { type: "tool_use", id: slot.id, name: slot.name, input: slot.input };
  }
}
