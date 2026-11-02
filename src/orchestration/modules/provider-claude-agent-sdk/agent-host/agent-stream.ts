import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { asRecord } from "../../../../infra/record.js";
import { LlmStreamError } from "../../../agent-runtime/llm/errors.js";
import type { CliBlock, CliMessage } from "../cli-view.js";
import { CLAUDE_AGENT_SDK_LABEL } from "../names.js";
import type { AgentRows, SignedBlock } from "./agent-file.js";
import type { HostStepItem } from "./host-gate.js";

/** How often the stream reads the agent file while it waits for the engine's row of a block. */
const ROW_POLL_MS = 20;
/** The longest wait for the engine's row of a block that the step already streamed. The engine writes it within
 *  moments of the block's end. */
const ROW_BOUND_MS = 10_000;

/** One event of an admitted step, as the host gate hands it on. */
export type StepEvent =
  | { readonly kind: "item"; readonly item: HostStepItem }
  | { readonly kind: "done" };

/** The response of one step, as the bridge holds it after the stream ended. */
export interface HostedAnswer {
  readonly message: CliMessage;
  readonly stopReason: string | null;
}

type OpenBlock =
  | { readonly kind: "text"; readonly index: number; text: string }
  | { readonly kind: "thinking"; readonly index: number; text: string }
  | { readonly kind: "tool"; readonly index: number; readonly id: string; readonly name: string; json: string };

/**
 * The Anthropic stream of one hosted agent's step, from the chunks that the engine's step hook passed on and the rows
 * that the engine wrote to the agent file (spike results; plan rule H10). It re-encodes the real model's response and
 * adds nothing: each thinking block takes its signature, and each redacted thinking block its data, from the engine's
 * row of that block, because the hook passes neither on. The usage is the response's own, from its stop chunk. A
 * step that ends without a stop chunk failed: the stream throws `failure()`, the service's answer from the record of
 * the step's request (`HostedRequests.failure`), which the shared adapter classifies as on the native route. `from`
 * is the number of signed blocks that the agent file held before the step was admitted. `onAnswer` gets the response
 * once it ended.
 *
 * @yields {Anthropic.RawMessageStreamEvent} The Anthropic stream events of the response.
 */
export async function* hostedStreamEvents(events: AsyncIterable<StepEvent>, rows: AgentRows, from: number, model: string, failure: () => Promise<Error>, onAnswer: (answer: HostedAnswer) => void): AsyncGenerator<Anthropic.RawMessageStreamEvent> {
  const content: CliBlock[] = [];
  let open: OpenBlock | undefined;
  let started = false;
  let signedRead = from;

  const nextSigned = async (): Promise<SignedBlock> => {
    const deadline = Date.now() + ROW_BOUND_MS;
    while (true) {
      const block = rows.read()[signedRead];
      if (block !== undefined) {
        signedRead += 1;
        return block;
      }
      if (Date.now() > deadline) throw new LlmStreamError(`The ${CLAUDE_AGENT_SDK_LABEL} agent host wrote no row for a signed block of the response`, "transient");
      await Bun.sleep(ROW_POLL_MS);
    }
  };

  /** Ends the open block: a thinking block first takes the rest of its text and its signature from its row.
   *  @yields {Anthropic.RawMessageStreamEvent} The block's last delta and its stop event. */
  async function* close(): AsyncGenerator<Anthropic.RawMessageStreamEvent> {
    const block = open;
    if (block === undefined) return;
    open = undefined;
    if (block.kind === "thinking") {
      const signed = await nextSigned();
      if (signed.type !== "thinking" || !signed.thinking.startsWith(block.text)) throw new LlmStreamError(`The ${CLAUDE_AGENT_SDK_LABEL} agent host's row of a thinking block differs from its stream`, "transient");
      if (signed.thinking.length > block.text.length) yield { type: "content_block_delta", index: block.index, delta: { type: "thinking_delta", thinking: signed.thinking.slice(block.text.length) } };
      yield { type: "content_block_delta", index: block.index, delta: { type: "signature_delta", signature: signed.signature } };
      content.push(signed);
    } else if (block.kind === "text") content.push({ type: "text", text: block.text });
    else content.push({ type: "tool_use", id: block.id, name: block.name, input: parsedInput(block.json) });
    yield { type: "content_block_stop", index: block.index };
  }

  /** A redacted thinking block yields no chunk, so the index of the next chunk skips it.
   *  @yields {Anthropic.RawMessageStreamEvent} The start and stop events of each skipped block, from its row. */
  async function* redacted(until: number): AsyncGenerator<Anthropic.RawMessageStreamEvent> {
    while (content.length < until) {
      const signed = await nextSigned();
      if (signed.type !== "redacted_thinking") throw new LlmStreamError(`The ${CLAUDE_AGENT_SDK_LABEL} agent host's stream skipped a block that is not redacted thinking`, "transient");
      yield { type: "content_block_start", index: content.length, content_block: { type: "redacted_thinking", data: signed.data } };
      yield { type: "content_block_stop", index: content.length };
      content.push(signed);
    }
  }

  for await (const event of events) {
    if (event.kind === "done") break;
    const { item } = event;
    if (!started) {
      started = true;
      // The usage comes with the stop chunk, which the stream sends in its `message_delta`.
      yield { type: "message_start", message: {
        id: `msg_host_${randomUUID()}`, type: "message", role: "assistant", model, content: [], container: null, stop_details: null, stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, server_tool_use: null, service_tier: null },
      } };
    }
    if (item.kind === "stop") {
      yield* close();
      const usage = item.usage;
      yield {
        type: "message_delta", delta: { stop_reason: stopReason(item.stopReason), stop_sequence: null, stop_details: null, container: null },
        usage: { output_tokens: usage?.output_tokens ?? 0, input_tokens: usage?.input_tokens ?? 0, cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0, cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0, server_tool_use: null },
      };
      yield { type: "message_stop" };
      onAnswer({ message: { role: "assistant", content }, stopReason: item.stopReason });
      return;
    }
    if (open !== undefined && open.index !== item.index) yield* close();
    if (open === undefined) {
      yield* redacted(item.index);
      if (item.kind === "text") {
        open = { kind: "text", index: item.index, text: "" };
        yield { type: "content_block_start", index: item.index, content_block: { type: "text", text: "", citations: null } };
      } else if (item.kind === "thinking") {
        open = { kind: "thinking", index: item.index, text: "" };
        yield { type: "content_block_start", index: item.index, content_block: { type: "thinking", thinking: "", signature: "" } };
      } else if (item.kind === "tool") {
        open = { kind: "tool", index: item.index, id: item.id, name: item.name, json: "" };
        yield { type: "content_block_start", index: item.index, content_block: { type: "tool_use", id: item.id, name: item.name, input: {}, caller: { type: "direct" } } };
        continue;
      } else continue;
    }
    if (item.kind === "text" && open.kind === "text") {
      open.text += item.text;
      yield { type: "content_block_delta", index: item.index, delta: { type: "text_delta", text: item.text } };
    } else if (item.kind === "thinking" && open.kind === "thinking") {
      open.text += item.text;
      yield { type: "content_block_delta", index: item.index, delta: { type: "thinking_delta", thinking: item.text } };
    } else if (item.kind === "input" && open.kind === "tool") {
      open.json += item.json;
      yield { type: "content_block_delta", index: item.index, delta: { type: "input_json_delta", partial_json: item.json } };
    }
  }
  throw await failure();
}

/** The stop chunk's reason, as the service named it. A reason that the SDK's type does not list reaches the adapter as
 *  text, which classifies it. */
function stopReason(reason: string | null): Anthropic.StopReason | null {
  // SAFETY: the adapter reads the reason as a string (`resolveAnthropicStopReason`), as it reads the service's own.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the engine passes the service's stop reason on as text
  return reason as Anthropic.StopReason | null;
}

/** A tool call's input. The adapter reads the input's JSON from the deltas, so this value only completes the block. */
function parsedInput(json: string): { readonly [field: string]: unknown } {
  try {
    return asRecord(JSON.parse(json === "" ? "{}" : json)) ?? {};
  } catch {
    return {};
  }
}
