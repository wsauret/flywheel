import { randomUUID } from "node:crypto";
import { Effect, Exit, Scope } from "effect";
import type { AgentDefinition } from "../../infra/agent-definition.js";
import type { AgentLoopWakeInput } from "../../infra/agent-loop-events.js";
import type { ProjectDefinitionRegistry } from "../../workflows/definition-registry.js";
import { errorMessage } from "../../infra/error-message.js";
import { Log } from "../../infra/log.js";
import { runAgentLoop } from "./agent-loop.js";
import { createAgentRunTally, type AgentRunTally } from "./agent-loop-state.js";
import type { BreadcrumbMaintenance } from "../session/session-artifacts.js";
import { AgentAborted, type AgentRuntimeError, isAgentRuntimeError, toFailureReason } from "./errors.js";
import { PersistenceWriteRefused } from "../../infra/event-store-types.js";
import type { CaptureModelRuntime, LLMClientFactory } from "./factory.js";
import type { ModelClient } from "./llm/types.js";
import { RunLifecycle } from "./run-lifecycle.js";
import { assembleRuntimeForTurn, resolveRunnerSignal } from "./runtime-assembly.js";
import { ProviderRuntimeCache, type ProviderSession } from "./provider-runtime-cache.js";
import { resolveRuntimeConversation, type RuntimeConversation } from "./runtime-conversation.js";
import { observeSessionRun } from "./session-run-observation.js";
import type { AgentRunResult, Agent, RunnableAgentOptions } from "./types.js";


const log = Log.create({ service: "agent-runner" });


function parentToolUseId(options: RunnableAgentOptions): string | undefined {
  return options.purpose.kind === "subagent" ? options.purpose.parentToolUseId : undefined;
}

export class LiveAgent implements Agent {
  readonly done: Promise<AgentRunResult>;
  readonly providerSessionKey: string;

  /** Personas this runner may dispatch, for its whole lifetime. A workflow
   *  worker and a nested subagent are handed the registry their parent pinned;
   *  a chat runner reads one for its own project root. Either way the tree is
   *  walked at most once per runner, never once per turn, and the composition
   *  cannot change under a run that is already in flight. */
  private readonly personas: ReadonlyMap<string, AgentDefinition>;
  private readonly conversation: RuntimeConversation;


  private readonly lifecycle = new RunLifecycle<AgentRunResult>();
  /** The provider runtime of the run: the session's (`AgentBaseOptions.providerSession`), or one that the run owns
   *  and ends with it. */
  private readonly provider: ProviderSession;
  /** The scope that ends with a run whose provider session outlives it (`AssembleInput.runScope`). */
  private readonly runScope: Scope.Closeable | undefined;
  private readonly loadedSkillIds = new Set<string>();
  private readonly loadedBundledSkillIds = new Set<string>();

  constructor(
    private readonly options: RunnableAgentOptions,
    private readonly createLLMClient: LLMClientFactory,
    /** Definition owner of the project this runner serves. Passed on to every
     *  subagent it dispatches, so one dispatch tree composes from one registry. */
    private readonly definitions: ProjectDefinitionRegistry,
    private readonly breadcrumbMaintenance: BreadcrumbMaintenance,
    providerRuntimeCache?: ProviderRuntimeCache<ModelClient>,
    private readonly captureModelRuntime: CaptureModelRuntime = async () => ({ generation: createLLMClient, createLLMClient }),
  ) {
    const runId = randomUUID();
    this.conversation = resolveRuntimeConversation(options.conversation, {
      providerSessionKey: `agent-${runId}`,
      artifactScopeId: `artifact-${runId}`,
      retrievalSessionId: `retrieval-${runId}`,
    });
    this.providerSessionKey = this.conversation.providerSessionKey;
    this.personas = options.agentRegistry ?? definitions.personas();
    const settled = this.lifecycle.done;
    if (options.providerSession !== undefined) {
      const runScope = Scope.makeUnsafe("sequential");
      this.provider = options.providerSession;
      this.runScope = runScope;
      this.done = settled.finally(() => Effect.runPromise(Scope.close(runScope, Exit.void)));
    } else {
      const owned = { cache: providerRuntimeCache ?? new ProviderRuntimeCache<ModelClient>(), scope: Scope.makeUnsafe("sequential") };
      this.provider = owned;
      this.runScope = undefined;
      // A run that ends aborted ended on a stop decision, whether `abort()` or the
      // caller's lifecycle signal made it, so its providers see the close as an interrupt.
      this.done = settled.finally(async () => {
        owned.cache.dispose();
        const stopped = await settled.then((result) => result.terminal.kind === "aborted", () => false);
        await Effect.runPromise(Scope.close(owned.scope, stopped ? Exit.interrupt() : Exit.void));
      });
    }
  }

  send(input: string | AgentLoopWakeInput): void {
    // Subsequent sends are already in the session queue (chat-controls pushes
    // before calling send); the loop picks them up via turnPolicy.onLoopTop.
    const capturedSessionId = Log.currentSessionId();
    const started = this.lifecycle.start((abortSignal) => {
      const run = (): Promise<AgentRunResult> => this.runOnce(input, abortSignal);
      // Effect.runFork breaks AsyncLocalStorage propagation. Capture the
      // ambient session context and re-establish it so every module-level
      // logger (agent-loop, tools, LLM clients) routes to the session log.
      return capturedSessionId ? Log.runWithSession(capturedSessionId, run) : run();
    });
    // Observability, not a fallback: start() returns false only when a run is
    // already in flight. The message is already enqueued by chat-controls via
    // lifecycle.enqueueInput, so re-enqueuing here would duplicate it. Trace
    // the discarded fresh-start so an unexpected concurrent send() is visible.
    if (!started) log.warn("concurrent send() on a running runner; discarded (already enqueued)", { providerSessionKey: this.providerSessionKey });
  }

  end(): void {
    // Caller's pledge not to call send() again; the loop exits naturally once
    // the queue drains and the model yields with no tool calls.
  }

  abort(): void {
    this.lifecycle.abort({
      durationMs: 0,
      providerSessionKey: this.providerSessionKey,
      servedRequests: 0,
      terminal: { kind: "aborted" },
    });
  }

  interruptGeneration(): boolean {
    return this.lifecycle.interrupt();
  }

  /** The run itself: one Promise the retained RunLifecycle fiber owns through
   *  its bridge. `abortSignal` is the bridge's stop signal, so an aborted run
   *  asks this work to stop and the fiber stays open until this Promise has
   *  really settled - assembly, loop, and the `finally` below included. */
  private async runOnce(input: string | AgentLoopWakeInput, abortSignal: AbortSignal): Promise<AgentRunResult> {
    const options = this.options;
    const signal = resolveRunnerSignal(options, abortSignal);
    const instruction = typeof input === "string" ? input : null;
    const startTime = Date.now();
    const tally = options.tally ?? createAgentRunTally();
    const effort = typeof options.effort === "function" ? "live" : options.effort;

    try {
      // DEBUG: the run's one default-level record is its completion. A run
      // that never completes shows through the session's in-flight state and
      // the shutdown record.
      log.debug("agent runner starting", {
        providerSessionKey: this.providerSessionKey,
        model: options.model,
        effort,
        hasHandoff: options.runtimeSurfaces?.handoff !== undefined,
        parentToolUseId: parentToolUseId(options),
        maxLLMCalls: options.maxLLMCalls,
      });

      const loopOptions = await assembleRuntimeForTurn({
        options,
        definitions: this.definitions,
        conversation: this.conversation,
        signal,
        disposalSignal: abortSignal,
        instruction,
        currentTurn: this.lifecycle,
        personas: this.personas,
        loadedSkillIds: this.loadedSkillIds,
        loadedBundledSkillIds: this.loadedBundledSkillIds,
        captureModelRuntime: this.captureModelRuntime,
        createRunner: (opts) => new LiveAgent(opts, this.createLLMClient, this.definitions, this.breadcrumbMaintenance, undefined, this.captureModelRuntime),
        providerRuntimeCache: this.provider.cache,
        providerSessionLifetime: {
          providerSessionKey: this.providerSessionKey, scope: this.provider.scope,
          ...(this.provider.demand === undefined ? {} : { demand: this.provider.demand }),
        },
        ...(this.runScope === undefined ? {} : { runScope: this.runScope }),
      });
      const sessionRun = await observeSessionRun(loopOptions, options.purpose, options.runtimeSurfaces?.sessions);
      const terminal = await runAgentLoop({ ...sessionRun.loopOptions, tally });
      sessionRun.ended(terminal);

      log.info("agent runner completed", {
        providerSessionKey: this.providerSessionKey,
        terminal: terminal.kind,
        durationMs: Date.now() - startTime,
        model: options.model,
        effort,
        parentToolUseId: parentToolUseId(options),
        ...tally,
      });
      return {
        durationMs: Date.now() - startTime,
        providerSessionKey: this.providerSessionKey,
        servedRequests: tally.served,
        terminal,
      };
    } catch (err) {
      if (err instanceof PersistenceWriteRefused) throw err;
      // An aborted run reports the abort, whatever rejection the unwinding work
      // surfaced. Anything else that is not a typed runtime error is a defect:
      // rethrow it so the owning fiber dies loudly instead of reporting a
      // synthesized failure the run never had.
      const failure = signal.aborted ? new AgentAborted() : isAgentRuntimeError(err) ? err : null;
      if (failure === null) throw err;
      return runtimeFailureResult(failure, this.providerSessionKey, options, startTime, tally);
    } finally {
      this.breadcrumbMaintenance.request();
    }
  }
}

function runtimeFailureResult(
  error: AgentRuntimeError,
  providerSessionKey: string,
  options: RunnableAgentOptions,
  startTime: number,
  tally: AgentRunTally,
): AgentRunResult {
  const failure = toFailureReason(error);
  const fields = { providerSessionKey, model: options.model, parentToolUseId: parentToolUseId(options), durationMs: Date.now() - startTime, ...tally };
  // An abort is an outcome, not a failure: an interrupt or a planned
  // replacement asked the run to stop. It records the run's completion, as a
  // run whose loop returned `aborted` does.
  if (failure.kind === "aborted") log.info("agent runner completed", { ...fields, terminal: failure.kind });
  else log.error("agent runner failed", { ...fields, failureKind: failure.kind, error: errorMessage(error) });
  return {
    durationMs: Date.now() - startTime,
    providerSessionKey,
    servedRequests: tally.served,
    terminal: failure,
  };
}
