/**
 * Subagent self-summary on failure.
 *
 * When a subagent fails mid-run after performing real work, this turns the
 * captured turn log into a short narrative the parent can use to decide
 * whether to retry, narrow scope, or surface to the user.
 *
 * Two paths:
 *  - LLM-backed: ask the subagent-summary role to emit `{ "summary": "..." }` JSON.
 *    Parsed via the 3-stage `tryParseJsonFromText` extractor.
 *  - Deterministic fallback: walk the turn log with `buildFallbackSummary`.
 *    Used when there's too little work, the LLM call fails, or the response
 *    is malformed.
 *
 * The summary is appended to the failure message returned to the parent's
 * tool_result - it does NOT mutate the conversation or replace messages.
 *
 */

import { Cause, Effect, Exit, Fiber } from "effect";
import { mergeAbortSignals } from "../../../../infra/abort.js";
import { errorMessage } from "../../../../infra/error-message.js";
import { Log } from "../../../../infra/log.js";
import { bridgeExternalPromise } from "../../../agent-runtime/external-promise-bridge.js";
import { failureTerminal, type Agent, type RunnableAgentOptions } from "../../../agent-runtime/types.js";
import type { SessionFactWriter } from "../../../session/session-fact-writer.js";
import type { AsyncEventStateReadSurface } from "../../../../infra/event-store-types.js";
import { createAgentHost } from "../../../runner/host.js";
import { tryParseJsonFromText } from "./json-extract.js";
import {
  buildFallbackSummary,
  buildSubagentWorkLog,
  type SubagentToolCallRecord,
} from "./work-log.js";

const log = Log.create({ service: "subagent-failure-summary" });

/** Short logs do not justify an extra LLM round-trip, so fewer than three
 *  recorded tool calls use the deterministic fallback directly. */
export const MIN_RECORDS_FOR_LLM_SUMMARY = 3;

const SUMMARY_TIMEOUT_MS = 8_000;

const SUMMARY_SYSTEM_PROMPT = `You summarize a failed subagent run for its parent agent so the parent can decide whether to retry, adjust scope, or surface to the user.

Read the work log and the terminating error. Produce ONE JSON object:

{"summary": "<1-2 sentence narrative of what was attempted and where it broke>"}

The summary MUST be concrete: name files, commands, search patterns where relevant. Do not invent results that aren't in the log. Do not include any preamble, prose, or commentary outside the JSON object.`;

/** The options of the summary's side call that its caller owns: where it runs, how its model is selected and its
 *  usage settled, and the chat tree whose agent host serves it. */
type SummaryRunnerOptions = Omit<RunnableAgentOptions, "purpose" | "conversation" | "lifecycle" | "maxLLMCalls" | "onEvent">;

export interface SummarizeSubagentWorkInput {
  records: ReadonlyArray<SubagentToolCallRecord>;
  terminalError: string;
  createRunner: (options: RunnableAgentOptions) => Agent;
  /** Read inside the summary's deadline and cancellation, only when the summary asks the model. */
  runnerOptions: () => Promise<SummaryRunnerOptions>;
  /** The failed child, whose session owns the summary's request evidence and usage. */
  child: {
    readonly sessionId: string;
    readonly conversationId: string;
    readonly writer: SessionFactWriter;
    readonly reader: AsyncEventStateReadSurface;
  };
  signal?: AbortSignal;
}

/** No access provider could serve the summary's side call. The summary is optional, so this one failure takes the
 *  deterministic fallback; every other failure of the run propagates to the summary's owner. */
class SummaryCandidatesExhausted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummaryCandidatesExhausted";
  }
}

export async function summarizeSubagentWork(input: SummarizeSubagentWorkInput): Promise<string> {
  const { records, terminalError, signal } = input;
  if (signal?.aborted || records.length < MIN_RECORDS_FOR_LLM_SUMMARY) {
    return buildFallbackSummary(records);
  }

  const workLog = buildSubagentWorkLog(records);
  const userPrompt = `The subagent encountered this terminating error: ${terminalError}\n\nHere is the work log:\n\n<workLog>\n${workLog}\n</workLog>\n\nReturn a single JSON object with key "summary".`;

  const startTime = performance.now();
  try {
    const deadline = AbortSignal.timeout(SUMMARY_TIMEOUT_MS);
    const waitSignal = mergeAbortSignals(signal, deadline);
    const bridge = bridgeExternalPromise((ownedSignal) =>
      callLLMForSummary(input, userPrompt, mergeAbortSignals(waitSignal, ownedSignal)));
    // The provider keeps its owning fiber until it actually settles. Only the optional
    // summary's wait ends at the deadline or Stop, not the provider's release.
    const owner = Effect.runFork(bridge.owned);
    const waited = await Effect.runPromiseExit(Fiber.await(owner), { signal: waitSignal });
    if (waitSignal.aborted) {
      bridge.stop();
      if (!signal?.aborted) log.warn("subagent summary timed out, using deterministic fallback", { recordCount: records.length });
      return buildFallbackSummary(records);
    }
    if (Exit.isFailure(waited)) throw Cause.squash(waited.cause);
    const exit = waited.value;
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
    const llmResult = exit.value;
    let parsed: ReturnType<typeof tryParseJsonFromText>;
    try {
      parsed = tryParseJsonFromText(llmResult);
    } catch {
      return buildFallbackSummary(records);
    }
    const summary =
      typeof parsed === "object" && parsed !== null && "summary" in parsed ? parsed.summary : undefined;
    if (typeof summary !== "string" || summary.trim() === "") {
      log.warn("subagent summary missing 'summary' string, using fallback", {
        recordCount: records.length,
      });
      return buildFallbackSummary(records);
    }
    log.debug("subagent failure summarized via LLM", {
      recordCount: records.length,
      summaryChars: summary.length,
      durationMs: Math.round(performance.now() - startTime),
    });
    return summary;
  } catch (err) {
    if (signal?.aborted) return buildFallbackSummary(records);
    if (!(err instanceof SummaryCandidatesExhausted)) throw err;
    log.warn("subagent summary LLM call failed, using deterministic fallback", {
      error: errorMessage(err),
      recordCount: records.length,
    });
    return buildFallbackSummary(records);
  }
}

/** Asks the summary model through one side call of the failed child's chat tree: an agent of the tree's shared
 *  host, advertised the tree's tools, refusing every call. A side call adds no launch value: a per-call launch value
 *  starts another Claude engine process, so it belongs in HOST_SPLIT_EXCEPTIONS
 *  (provider-claude-agent-sdk/agent-host/host-registry.ts) with its reason. */
async function callLLMForSummary(
  input: SummarizeSubagentWorkInput,
  userPrompt: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const { child } = input;
  const text: string[] = [];
  const result = await createAgentHost<RunnableAgentOptions>({ createRunner: input.createRunner }).runTurn({
    createContextOptions: async () => {
      text.length = 0;
      return {
        ...await input.runnerOptions(),
        purpose: { kind: "subagent-failure-summary", prompt: { kind: "literal", systemPrompt: SUMMARY_SYSTEM_PROMPT } },
        conversation: {
          kind: "replay",
          // The summary's request evidence and usage settle as the child's own requests do.
          providerSessionKey: child.conversationId,
          priorMessages: [{ kind: "user", content: userPrompt }],
          requestAccounting: { owner: { kind: "session", sessionId: child.sessionId }, streamId: child.sessionId, writer: child.writer, reader: child.reader },
        },
        lifecycle: { kind: "one-shot", ...(signal ? { signal } : {}) },
        maxLLMCalls: 1,
        onEvent: (event) => {
          if (event.type !== "model.assistant_message.recorded") return;
          for (const block of event.data.message?.content ?? []) if (block.type === "text") text.push(block.text);
        },
      };
    },
    message: "",
    resilience: signal ? { signal } : {},
  });
  const failure = failureTerminal(result.terminal);
  if (failure?.kind === "api_error" && failure.candidatesExhausted) throw new SummaryCandidatesExhausted(failure.message);
  if (failure) throw new Error(`Summary run failed: ${"message" in failure ? failure.message : failure.kind}`);
  return text.join("");
}
