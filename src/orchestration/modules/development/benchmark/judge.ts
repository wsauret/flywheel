import type { RuntimeEvent } from "../../../../infra/runtime-event-types.js";
import { failureTerminal, type AgentFactory, type AgentRunTerminal, type RuntimeToolSurfaces } from "../../../agent-runtime/types.js";
import { createBenchmarkAccounting } from "./accounting.js";
import { invokeBenchmarkAgent } from "./invocation.js";
import type { JudgeScoreIdentity, JudgeTerminal } from "./run-store.js";
import type { BenchmarkAccounting } from "./evidence.js";
import { buildResearchPairJudgePrompt } from "../../../../infra/benchmark-rubrics.js";
import type { CaptureProviderConnection } from "../../../agent-runtime/factory.js";
import { resolveSessionRoles } from "../../../config/session-role-resolver.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What one judge call spent, as it was observed. Accounting only: it names no
 *  credential and carries no request or response content. */
export type JudgeAccounting = BenchmarkAccounting;

/** One settled judge call, as every judged loop reports it: which score the
 *  call was for, how it ended, and what it cost. */
export interface JudgeAttemptReport {
  score: JudgeScoreIdentity;
  terminal: JudgeTerminal;
  accounting: JudgeAccounting;
}

type JudgeAttemptWriter = (attempt: JudgeAttemptReport) => Promise<void>;

/** Accounting for a call that measured nothing. A fabricated zero would
 *  misreport spend, so the reason travels with the gap. */
export function unavailableJudgeAccounting(reason: string): JudgeAccounting {
  const unavailable = { kind: "unavailable", reason } as const;
  return {
    estimatedUsd: unavailable,
    billedUsd: unavailable,
    tokens: unavailable,
    providers: unavailable,
    pricedEntryCount: 0,
    unpricedEntryCount: 0,
  };
}

/** What a judge call produced, and what producing it cost. */
interface JudgeCompletion {
  text: string;
  accounting: JudgeAccounting;
}

/** A judge call that produced no usable text. It carries the accounting of the
 *  work already paid for, so a failed call is still accounted. */
export class JudgeCallFailure extends Error {
  constructor(readonly accounting: JudgeAccounting, message: string) {
    super(message);
    this.name = "JudgeCallFailure";
  }
}

/** One judge call, as every benchmark surface makes it. `signal` is the
 *  caller's cancellation request: an implementation must stop the work it
 *  started, and its promise settles only when that work is over. The caller
 *  owns the bound and awaits the settlement, so nothing downstream of a judge
 *  call outlives it. */
export interface JudgeModel {
  complete(prompt: string, signal: AbortSignal): Promise<JudgeCompletion>;
}

export interface AgentJudgeOptions {
  readonly createAgent: AgentFactory;
  readonly model?: string;
  readonly captureProviderConnection?: CaptureProviderConnection;
  readonly evidenceDirectory?: string;
  /** A harness scoring rule applied to the resolved model before any provider request. */
  readonly validateModel?: (model: string) => void;
  /** Authored effort for this call. Unreachable model settings fall through as a pair. */
  readonly effort?: string;
  readonly systemPrompt?: string;
  readonly userDataRoot: string;
  readonly accountHome: string;
  readonly profileId?: string;
  readonly authorityIncarnation?: string;
  readonly runtimeSurfaces?: Pick<RuntimeToolSurfaces, "launcher" | "background" | "foregroundBashHold" | "shell">;
}

function terminalMessage(model: string | undefined, terminal: AgentRunTerminal): string {
  if ("message" in terminal) return terminal.message;
  return `Judge model ${model} ended as ${terminal.kind}`;
}

/** Builds the tool-free, one-call Agent judge shared by every benchmark surface. */
export function createAgentJudge(options: AgentJudgeOptions): JudgeModel {
  return {
    async complete(prompt: string, signal: AbortSignal): Promise<JudgeCompletion> {
      const ledger = createBenchmarkAccounting();
      const captureProviderConnection = options.captureProviderConnection;
      const evidenceId = crypto.randomUUID();
      let text = "";
      const accounting = (): JudgeAccounting => ledger.observe();
      const onEvent = (event: RuntimeEvent): void => {
        if (event.type === "model.usage.measured") ledger.commit(event.data.usage_entry);
        if (event.type !== "model.assistant_message.recorded") return;
        text = (event.data.message?.content ?? [])
          .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
          .map((block) => block.text)
          .join("");
      };
      // The judge scores only the text it is given, so it runs in an empty
      // directory of its own. In the process's working directory it read
      // whatever project was there, which can bias a score and cost most of
      // each call.
      const blindRoot = await mkdtemp(join(tmpdir(), "flywheel-judge-"));
      try {
        const run = await invokeBenchmarkAgent({
          createAgent: options.createAgent,
          runtimeSurfaces: options.runtimeSurfaces ?? {},
          agentOptions: {
            model: options.model,
            ...(options.effort ? { effort: options.effort } : {}),
            ...(captureProviderConnection ? {
              captureProviderConnection,
              resolveRoles: async (captured) => {
                const capture = captured ?? await captureProviderConnection();
                const roles = await resolveSessionRoles({
                  defaults: {}, overrides: options.model === undefined && options.effort === undefined ? {} : { "benchmark-judge": { model: options.model, effort: options.effort } },
                }, capture, options.userDataRoot);
                const selected = roles.get("benchmark-judge");
                if (selected) options.validateModel?.(selected.model);
                if (options.evidenceDirectory) {
                  const directory = join(options.evidenceDirectory, capture.connection.profileId, evidenceId);
                  await mkdir(directory, { recursive: true });
                  await Bun.write(join(directory, "roles.json"), JSON.stringify(Object.fromEntries([...roles].map(([id, role]) => [id, { model: role.model, effort: role.effort }])), null, 2));
                }
                return roles;
              },
              requestSelection: (roles) => ({ roleId: "benchmark-judge", ...roles.get("benchmark-judge") }),
            } : {}),
            purpose: {
              kind: "headless-task",
              prompt: { kind: "literal", systemPrompt: options.systemPrompt ?? "" },
            },
            executionCwd: blindRoot,
            projectRoot: blindRoot,
            userDataRoot: options.userDataRoot,
            accountHome: options.accountHome,
            ...(options.profileId ? { activeProfileId: options.profileId } : {}),
            onEvent,
            toolProfile: "none",
            maxLLMCalls: 1,
          },
          prompt,
          signal,
        });
        signal.throwIfAborted();
        const failure = run.terminal.kind === "interrupted" || run.terminal.kind === "input_closed"
          ? { kind: "aborted" as const }
          : failureTerminal(run.terminal);
        if (failure) throw new Error(terminalMessage(options.model, failure));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new JudgeCallFailure(accounting(), message);
      } finally {
        await rm(blindRoot, { recursive: true, force: true });
      }
      if (!text.trim()) throw new JudgeCallFailure(accounting(), `Judge model ${options.model} returned no text`);
      return { text, accounting: accounting() };
    },
  };
}

export interface JudgeSettlement<T> {
  value: T;
  error: string | null;
}

type JudgeSettlementWriter<T> = (settlement: JudgeSettlement<T>) => Promise<void>;

/** Every judged loop shares these: priors to reuse, where each settlement is
 *  recorded, where each call's accounting is recorded, the per-call bound, and
 *  the cancellation the caller owns. */
export interface JudgeLoopOptions<T> {
  existing?: readonly T[];
  onSettled?: JudgeSettlementWriter<T>;
  onAttempt?: JudgeAttemptWriter;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type JudgePairOptions = JudgeLoopOptions<JudgeVerdict>;

export interface JudgeCandidate {
  variant: string;
  task: string;
  repeat: number;
  summary: string;
}

export interface JudgeVerdict {
  task: string;
  repeat: number;
  slotA: string;
  slotB: string;
  winner: string | "tie";
  rationale: string;
}

export type JudgePromptBuilder = (taskPrompt: string, summaryA: string, summaryB: string) => string;

interface SlotVerdict {
  winner: "A" | "B" | "tie";
  rationale: string;
}

function parseVerdict(text: string): JudgeSettlement<SlotVerdict> {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { value: { winner: "tie", rationale: "The judge response was not valid JSON." }, error: "Judge response did not contain JSON" };
  try {
    const parsed = JSON.parse(match[0]);
    if (typeof parsed !== "object" || parsed === null || !("winner" in parsed) || !("rationale" in parsed)) {
      return { value: { winner: "tie", rationale: "The judge response was not a JSON object." }, error: "Judge response was not a JSON object" };
    }
    const { winner, rationale } = parsed;
    if ((winner !== "A" && winner !== "B" && winner !== "tie") || typeof rationale !== "string") {
      return { value: { winner: "tie", rationale: "The judge response did not match the verdict schema." }, error: "Judge response did not match the verdict schema" };
    }
    return { value: { winner, rationale }, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { value: { winner: "tie", rationale: "The judge response was not valid JSON." }, error: `Judge response JSON failed to parse: ${message}` };
  }
}

const JUDGE_CANCELLED = "Judge call was cancelled";

/** What one bounded judge call settled as: its text or the reason it produced
 *  none, how it ended, and what it cost. */
export interface JudgeCallSettlement extends JudgeSettlement<string> {
  terminal: JudgeTerminal;
  accounting: JudgeAccounting;
}

/** One judge call, bounded by `timeoutMs` and by `signal`. A bound does not
 *  abandon the call: it requests cancellation through the signal the judge is
 *  given and then awaits that call's real settlement, so a benchmark's terminal
 *  event never lands while a judge request is still in flight. A bounded call
 *  produces no score, and its accounting survives either way: the request was
 *  paid for whether or not its answer arrived. */
export async function completeJudge(model: JudgeModel, prompt: string, timeoutMs = 120_000, signal?: AbortSignal): Promise<JudgeCallSettlement> {
  const call = new AbortController();
  let bound: { reason: string; terminal: JudgeTerminal } | undefined;
  const bind = (reason: string, terminal: JudgeTerminal): void => {
    bound ??= { reason, terminal };
    call.abort();
  };
  const timer = setTimeout(() => bind(`Judge call timed out after ${timeoutMs} ms`, "timed-out"), timeoutMs);
  const onAbort = (): void => bind(JUDGE_CANCELLED, "cancelled");
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const completion = await model.complete(prompt, call.signal);
    return bound === undefined
      ? { value: completion.text, error: null, terminal: "completed", accounting: completion.accounting }
      : { value: "", error: bound.reason, terminal: bound.terminal, accounting: completion.accounting };
  } catch (error) {
    const accounting = error instanceof JudgeCallFailure
      ? error.accounting
      : unavailableJudgeAccounting("the judge call failed before it reported usage");
    const message = error instanceof Error ? error.message : String(error);
    return bound === undefined
      ? { value: "", error: `Judge call failed: ${message}`, terminal: "failed", accounting }
      : { value: "", error: bound.reason, terminal: bound.terminal, accounting };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function pairKey(task: string, repeat: number, variantA: string, variantB: string): string {
  return `${task}\u0000${repeat}\u0000${[variantA, variantB].sort().join("\u0000")}`;
}

export async function judgePairs(
  results: readonly JudgeCandidate[],
  taskPrompts: ReadonlyMap<string, string>,
  model: JudgeModel,
  flip: () => boolean = () => Math.random() < 0.5,
  promptBuilder: JudgePromptBuilder = buildResearchPairJudgePrompt,
  options: JudgePairOptions = {},
): Promise<JudgeVerdict[]> {
  const taskRepeats = new Map<string, { task: string; repeat: number }>();
  for (const result of results) {
    taskRepeats.set(`${result.task}\u0000${result.repeat}`, { task: result.task, repeat: result.repeat });
  }
  const existing = new Map((options.existing ?? []).map((verdict) => [pairKey(verdict.task, verdict.repeat, verdict.slotA, verdict.slotB), verdict]));
  const verdicts: JudgeVerdict[] = [];
  for (const { task, repeat } of taskRepeats.values()) {
    const cell = results.filter((result) => result.task === task && result.repeat === repeat);
    if (cell.length < 2) continue;
    const taskPrompt = taskPrompts.get(task);
    if (!taskPrompt) throw new Error(`Missing prompt for task ${task}`);
    for (let i = 0; i < cell.length; i++) {
      for (let j = i + 1; j < cell.length; j++) {
        if (options.signal?.aborted) return verdicts;
        const first = cell[i];
        const second = cell[j];
        if (!first || !second) throw new Error(`Missing summary pair for ${task} repeat ${repeat}`);
        const key = pairKey(task, repeat, first.variant, second.variant);
        const prior = existing.get(key);
        if (prior) {
          verdicts.push(prior);
          continue;
        }
        const firstInA = flip();
        const slotA = firstInA ? first : second;
        const slotB = firstInA ? second : first;
        const completion = await completeJudge(model, promptBuilder(taskPrompt, slotA.summary, slotB.summary), options.timeoutMs, options.signal);
        // The call is accounted before anything is published: the request was
        // paid for whatever it produced.
        await options.onAttempt?.({
          score: { kind: "pair-score", task, repeat, slotA: slotA.variant, slotB: slotB.variant },
          terminal: completion.terminal,
          accounting: completion.accounting,
        });
        if (completion.terminal === "cancelled") return verdicts;
        const parsed = completion.error === null ? parseVerdict(completion.value) : { value: { winner: "tie", rationale: completion.error } satisfies SlotVerdict, error: completion.error };
        const verdict: JudgeVerdict = {
          task,
          repeat,
          slotA: slotA.variant,
          slotB: slotB.variant,
          winner: parsed.value.winner === "tie" ? "tie" : parsed.value.winner === "A" ? slotA.variant : slotB.variant,
          rationale: parsed.value.rationale,
        };
        await options.onSettled?.({ value: verdict, error: parsed.error });
        // Errored verdicts are persisted for audit only: they must not count
        // as real ties, and --rescore retries them because priors are
        // filtered to error-free records.
        if (parsed.error === null) verdicts.push(verdict);
        // A completion that a cancellation followed is kept: it was paid for
        // and recorded. The stop applies to the calls that would come next.
        if (options.signal?.aborted) return verdicts;
      }
    }
  }
  return verdicts;
}
