import { LlmStreamError, OutputLengthExceededError } from "../../agent-runtime/llm/errors.js";
import type { StreamLiveness } from "../../agent-runtime/llm/stream/stream-liveness.js";
import type { ProviderStreamEvent, ToolCall } from "../../agent-runtime/llm/types.js";
import type { CompletedStopReason } from "../../../infra/providers/llm/conversation/messages.js";
import type { AcpCloseReason } from "./acp/connection.js";
import type { AcpPromptResult, AcpSessionUpdate, AcpUsage } from "./acp/schema.js";
import { engineFailure, engineNoticeDetail, engineStoppedFailure } from "./acp/errors.js";
import type { RowUsage, UsageLedger } from "./usage/conversation-usage.js";

type ModelFrame = Extract<AcpSessionUpdate, { readonly sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "tool_call" }>;

/** The updates that show the model working on the session's current step. Everything else agy sends (the title,
 *  config and command lists, context occupancy, the echo of a user message, and the status of a tool call that
 *  Flywheel runs) is engine chatter that says nothing about the model. */
function isModelFrame(update: AcpSessionUpdate): update is ModelFrame {
  return update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk" || update.sessionUpdate === "tool_call";
}

/** One call of Flywheel's MCP tool server, as agy sent it: the tool's name and the arguments, without agy's own
 *  `toolSummary`, which agy strips before the call. */
export interface McpToolCall {
  readonly name: string;
  readonly arguments: ToolCall["input"];
}

export interface RequestStreamOptions {
  /** Unique per Flywheel request; prefixes the request's block keys. */
  readonly requestId: string;
  readonly liveness: Pick<StreamLiveness, "preStream" | "frame" | "begin" | "append" | "complete">;
  /** The request's dispatch observation (`StreamOptions.onDispatch`). */
  readonly onDispatch?: () => void | Promise<void>;
  /** The context occupancy that agy reports (`usage_update.used`), in tokens. */
  readonly onOccupancy: (used: number) => void;
  /** The tokens that earlier requests of the same agy prompt reported (`tokensReported`), which the prompt's
   *  aggregate at its end already holds. */
  readonly promptTokensReported: number;
  /** Whether a model request ran for the request: the gate admitted a step for it, or agy reported a model request's
   *  occupancy after its release. */
  readonly modelRequested: () => boolean;
  /** The usage ledger of the request's engine session, which states the usage of the request's model requests from
   *  agy's rows. */
  readonly usage: Pick<UsageLedger, "settle" | "endPrompt">;
}

/** The usage of a request that ran no model request, such as one that agy served a later call of a step that an
 *  earlier request reported. It spent nothing, which is a complete report. */
export const NO_MODEL_REQUEST_USAGE: ProviderStreamEvent = { kind: "usage", final: true, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 };

/**
 * The events of one Flywheel request on one agy session. The bridge feeds it the session's updates, the MCP call that
 * agy parks for the session, and the prompt's result, in arrival order, and yields the events each call returns. A
 * request settles once, at its single `tool_use` or at the end of the prompt; inputs after that are not its own.
 */
export interface RequestStream {
  /** The bridge sent the request's work to agy (a prompt or a delivered tool result). */
  released(): Promise<void>;
  update(update: AcpSessionUpdate): readonly ProviderStreamEvent[];
  toolCall(call: McpToolCall): readonly ProviderStreamEvent[];
  /** The end of the prompt. Throws the typed failure of a prompt that did not complete. */
  promptEnded(result: AcpPromptResult): readonly ProviderStreamEvent[];
  /** The failure of the request when agy's connection ended before it settled. */
  connectionEnded(reason: AcpCloseReason): Error;
  /** Whether the request reported its usage: the usage of its rows, partial usage at a call after a model request of
   *  its own, or the rest of the prompt's aggregate at the prompt's end. */
  readonly usageReported: boolean;
  /** The tokens that the request reported at its call, for the next request of the same prompt. */
  readonly tokensReported: number;
}

interface OpenBlock {
  readonly kind: "text" | "thinking";
  readonly key: string;
}

export function createRequestStream(options: RequestStreamOptions): RequestStream {
  const { liveness } = options;
  let blockOrdinal = 0;
  let block: OpenBlock | undefined;
  let text = "";
  /** The text of the open thinking block, which `thinking_complete` carries. */
  let thought = "";
  let responded = false;
  let settled = false;
  let usageReported = false;
  let tokensReported = 0;
  /** The total tokens of the request's own model request (`usage_update.used`), when agy sent one before it settled. */
  let measuredTokens = 0;
  /** A text chunk of the form of an agy failure notice, not yet decided. It is the failure when the prompt ends
   *  without usage, which agy reports for no failed prompt. It is model text when another model frame follows or the
   *  prompt ends with usage, and only then does it count as a model frame. */
  let notice: string | undefined;
  let revealedCallId: string | undefined;
  let parked: McpToolCall | undefined;

  const closeBlock = (): ProviderStreamEvent[] => {
    const open = block;
    if (open === undefined) return [];
    block = undefined;
    if (open.kind === "text") return [{ kind: "text_complete", blockKey: open.key }];
    liveness.complete(open.key);
    return thought === "" ? [] : [{ kind: "thinking_complete", thinking: thought, blockKey: open.key }];
  };

  const append = (kind: OpenBlock["kind"], delta: string): ProviderStreamEvent[] => {
    const events = block?.kind === kind ? [] : closeBlock();
    if (block === undefined) {
      block = { kind, key: `${options.requestId}:${kind}:${blockOrdinal++}` };
      if (kind === "thinking") {
        thought = "";
        liveness.begin(block.key);
      }
    }
    if (kind === "thinking") {
      thought += delta;
      liveness.append(delta);
      events.push({ kind: "thinking_delta", text: delta, blockKey: block.key });
    } else {
      text += delta;
      events.push({ kind: "text_delta", text: delta, blockKey: block.key });
    }
    return events;
  };

  /** A frame of the model, which also releases a held notice as the model's text. */
  const modelFrame = (): ProviderStreamEvent[] => {
    liveness.frame();
    const events: ProviderStreamEvent[] = responded ? [] : [{ kind: "provider_response_started" }];
    responded = true;
    if (notice !== undefined) {
      const held = notice;
      notice = undefined;
      events.push(...append("text", held));
    }
    return events;
  };

  const releaseNotice = (): ProviderStreamEvent[] => notice === undefined ? [] : modelFrame();

  /** The request's single call, once agy revealed it over ACP and parked it over MCP, in either order. */
  const settleCall = (): ProviderStreamEvent[] => {
    const toolUseId = revealedCallId;
    if (toolUseId === undefined || parked === undefined) return [];
    const { name, arguments: input } = parked;
    settled = true;
    return [
      ...releaseNotice(),
      ...closeBlock(),
      { kind: "tool_input_start", toolUseId, name },
      { kind: "tool_input_delta", toolUseId, partialJson: JSON.stringify(input) },
      { kind: "tool_use", toolCall: { id: toolUseId, name, input } },
      ...callUsage(),
      { kind: "done", stopReason: "tool_use" },
    ];
  };

  /** The complete usage of the request's own model requests, from the rows that agy recorded for them. */
  const rowUsage = (rows: RowUsage): ProviderStreamEvent => {
    usageReported = true;
    tokensReported = rows.inputTokens + rows.cacheReadTokens + rows.outputTokens;
    return { kind: "usage", final: true, inputTokens: rows.inputTokens, outputTokens: rows.outputTokens, cacheReadTokens: rows.cacheReadTokens, cacheCreateTokens: 0, reasoningTokens: rows.reasoningTokens };
  };

  /** The usage of a request that settles at a call while its prompt stays open: the usage of its rows, or zero for a
   *  request that ran no model request. When the rows cannot state it, agy's ACP reports give only a partial report:
   *  agy reports usage only for a whole prompt, at its end (also a cancelled one), and for each model request only its
   *  total (`usage_update.used`, measured on agy 1.5.14 to sum to the aggregate's input, cached reads, and output).
   *  That total is reported as input, so its estimate prices output and cached reads at the input rate until the
   *  request that ends the prompt reports the rest of the aggregate. */
  const callUsage = (): ProviderStreamEvent[] => {
    if (measuredTokens === 0 && !options.modelRequested()) {
      usageReported = true;
      return [NO_MODEL_REQUEST_USAGE];
    }
    const rows = options.usage.settle(measuredTokens);
    if (rows !== undefined) return [rowUsage(rows)];
    if (measuredTokens === 0) return [];
    usageReported = true;
    tokensReported = measuredTokens;
    return [{ kind: "usage", final: false, inputTokens: measuredTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 }];
  };

  /** The usage of the request that ends a prompt whose rows cannot state it: the rest of the prompt's aggregate after
   *  the reports of its earlier requests. Output and cached reads keep their reported counts and input takes the
   *  remainder, so the prompt's sums are exact; only when the earlier totals leave less than that does each count
   *  shrink in that order, and the prompt's total stays exact. */
  const aggregateRest = (usage: AcpUsage): ProviderStreamEvent => {
    usageReported = true;
    let rest = Math.max(0, usage.inputTokens + usage.cachedReadTokens + usage.cachedWriteTokens + usage.outputTokens - options.promptTokensReported);
    const take = (reported: number): number => {
      const taken = Math.min(reported, rest);
      rest -= taken;
      return taken;
    };
    // agy's `outputTokens` is the Gemini response's total less its prompt, which holds the thought tokens, so it
    // is Flywheel's output with reasoning included (measured on agy 1.5.14, ARCH-PROVIDERS-076). Reasoning stays within
    // the output that remains, so pricing never charges it twice or takes it from output's own share.
    const outputTokens = take(usage.outputTokens);
    const cacheReadTokens = take(usage.cachedReadTokens);
    const cacheCreateTokens = take(usage.cachedWriteTokens);
    return { kind: "usage", final: true, inputTokens: rest, outputTokens, cacheReadTokens, cacheCreateTokens, reasoningTokens: Math.min(usage.thoughtTokens, outputTokens) };
  };

  const done = (stopReason: CompletedStopReason, usage: AcpUsage | undefined): ProviderStreamEvent[] => {
    const events = [...releaseNotice(), ...closeBlock()];
    if (usage !== undefined) {
      const rows = options.usage.settle(measuredTokens);
      // The aggregate only checks the prompt's rows, which stay the usage.
      options.usage.endPrompt(usage);
      events.push(rows === undefined ? aggregateRest(usage) : rowUsage(rows));
    }
    events.push({ kind: "done", stopReason });
    return events;
  };

  return {
    async released() {
      liveness.preStream();
      await options.onDispatch?.();
    },
    update(update) {
      // Occupancy belongs to the session, also after the request settled at its call.
      if (update.sessionUpdate === "usage_update") {
        options.onOccupancy(update.used);
        if (!settled) measuredTokens = update.used;
        return [];
      }
      if (settled) return [];
      // A call that agy runs itself, such as its own `manage_task`, ends without an MCP call of Flywheel's server.
      if (update.sessionUpdate === "tool_call_update") {
        if (revealedCallId === update.toolUseId && parked === undefined && (update.status === "completed" || update.status === "failed")) revealedCallId = undefined;
        return [];
      }
      if (!isModelFrame(update)) return [];
      if (update.sessionUpdate === "agent_message_chunk" && engineNoticeDetail(update.content.text ?? "") !== undefined) {
        const events = releaseNotice();
        notice = update.content.text;
        return events;
      }
      const events = modelFrame();
      switch (update.sessionUpdate) {
        case "agent_message_chunk":
          if (update.content.text) events.push(...append("text", update.content.text));
          return events;
        case "agent_thought_chunk":
          if (update.content.text) events.push(...append("thinking", update.content.text));
          return events;
        case "tool_call":
          revealedCallId = update.toolUseId;
          return [...events, ...settleCall()];
      }
    },
    toolCall(call) {
      if (settled) return [];
      parked = call;
      return settleCall();
    },
    promptEnded(result) {
      if (settled) return [];
      settled = true;
      if (notice !== undefined && result.usage === undefined) throw engineFailure(engineNoticeDetail(notice) ?? notice);
      switch (result.stopReason) {
        case "end_turn": return done("end_turn", result.usage);
        // A refusal of the content completes the turn, as a Gemini safety stop does on the native route.
        case "refusal": return done("content_filter", result.usage);
        case "max_tokens":
          releaseNotice();
          throw new OutputLengthExceededError("Response truncated: max_tokens", text);
        case "max_turn_requests": throw new LlmStreamError("Google Antigravity ended the prompt at its turn limit", "unknown");
        case "cancelled": throw new LlmStreamError("Google Antigravity cancelled the prompt", "transient");
      }
    },
    connectionEnded(reason) {
      settled = true;
      return engineStoppedFailure(reason, responded);
    },
    get usageReported() {
      return usageReported;
    },
    get tokensReported() {
      return tokensReported;
    },
  };
}
