import type { AgentDefinition } from "../../../../infra/agent-definition.js";
import type { RuntimeEvent } from "../../../../infra/runtime-event-types.js";
import type { Agent, AgentFactory, AgentRunTerminal, RuntimeToolSurfaces } from "../../../agent-runtime/types.js";
import { failureTerminal } from "../../../agent-runtime/types.js";
import { agentTasksFromComposition, type ModuleAgentTasks } from "../../../module-agent-tasks.js";
import { composeFirstPartyModules } from "../../../modules.js";
import type { ToolRegistration } from "../../../agent-runtime/tools/tool-registry.js";
import type { FirstPartyModuleComposition, FirstPartyModuleSnapshot } from "../../../modules.js";
import { createAgentHost } from "../../../runner/host.js";
import { createBenchmarkAccounting } from "./accounting.js";
import type { BenchmarkAccounting } from "./evidence.js";

export type ChatRoutingOutcome =
  | { readonly kind: "dispatch"; readonly persona: string; readonly durationMs: number; readonly accounting: BenchmarkAccounting }
  | { readonly kind: "invalid-dispatch"; readonly evidence: string; readonly durationMs: number; readonly accounting: BenchmarkAccounting }
  | { readonly kind: "no-valid-dispatch"; readonly durationMs: number; readonly accounting: BenchmarkAccounting };

export type ChatRoutingFailureTerminal =
  | { readonly kind: "failed"; readonly code: "runner-failed" | "unexpected-error" }
  | { readonly kind: "provider-error"; readonly code: "api-error" | "api-overloaded" | "transient-disconnect" | "stream-stalled" }
  | { readonly kind: "timed-out"; readonly timeoutMs: number }
  | { readonly kind: "cancelled" };

export class ChatRoutingFailure extends Error {
  constructor(
    readonly terminal: ChatRoutingFailureTerminal,
    readonly durationMs: number,
    readonly accounting: BenchmarkAccounting,
  ) {
    super(terminal.kind === "timed-out" ? `Chat routing cancellation deadline elapsed after ${terminal.timeoutMs}ms` : terminal.kind === "cancelled" ? "Chat routing was cancelled" : `Chat routing ${terminal.kind}`);
    this.name = "ChatRoutingFailure";
  }
}

export interface ChatRoutingRequest {
  readonly model: string;
  readonly effort: string;
  readonly prompt: string;
  readonly deadlineMs: number;
  /** The trial's whole project: both the project root and the execution directory. ARCH-DIRECTORIES-015. */
  readonly workspace: string;
  readonly userDataRoot: string;
  readonly accountHome: string;
  readonly agentRegistry: ReadonlyMap<string, AgentDefinition>;
  readonly skills: Parameters<AgentFactory>[0]["skills"];
  readonly moduleSelection: FirstPartyModuleSnapshot;
  readonly runtimeSurfaces: RuntimeToolSurfaces;
  readonly signal?: AbortSignal;
}

export interface ChatRoutingDeps {
  readonly createAgent: AgentFactory;
  readonly closeOwnedBackground?: () => Promise<void>;
  readonly onInvalidDispatch?: (evidence: string) => void;
}

interface DispatchInput {
  [key: string]: unknown;
}

/** Reproducible provider-visible routing guidance for one agent registry: the
 *  dispatch tool's description and the subagent catalog the system prompt carries. */
export function chatRoutingGuidance(agentRegistry: ReadonlyMap<string, AgentDefinition>): string {
  const tasks = agentTasksFromComposition(composeFirstPartyModules());
  if (!tasks) throw new Error("No installed module provides agent task guidance");
  const tool = tasks.tool(async () => ({ content: "", outcome: "ok" }));
  return `${tool.description}\n\n${tasks.roster(agentRegistry)}`;
}

function safeInvalidEvidence(_input: Readonly<DispatchInput>): string {
  return "invalid-dispatch-input";
}

/** Replaces the dispatch tool's registrations with the production tool the
 *  model sees over the benchmark's intercept. A routing turn is stateless and
 *  has no session to own child work, so the real registration exposes nothing
 *  here; the agent-task contract builds the same tool without a session. */
function routingComposition(
  base: FirstPartyModuleComposition,
  intercept: (input: Readonly<DispatchInput>, tasks: ModuleAgentTasks) => Promise<{ readonly content: string; readonly outcome: "ok" | "error" }>,
): FirstPartyModuleComposition {
  const tasks = agentTasksFromComposition(base);
  if (!tasks) return base;
  return {
    ...base,
    contributions: base.contributions.map((contribution) => {
      if (contribution.domain !== "tools" || contribution.value.name !== tasks.toolId) return contribution;
      const { declaration } = contribution.value;
      const intercepted = (registration: ToolRegistration): ToolRegistration => ({
        ...registration,
        create: () => ({ tool: tasks.tool((input) => intercept(input, tasks)) }),
      });
      return {
        ...contribution,
        value: {
          ...contribution.value,
          declaration: {
            ...declaration,
            registrations: Object.fromEntries(Object.entries(declaration.registrations).map(([id, registration]) => [id, intercepted(registration)])),
          },
        },
      };
    }),
  };
}
export function failureFromTerminal(terminal: AgentRunTerminal): ChatRoutingFailureTerminal | null {
  const failure = failureTerminal(terminal);
  if (!failure) return null;
  switch (failure.kind) {
    case "api_error": return { kind: "provider-error", code: "api-error" };
    case "api_overloaded": return { kind: "provider-error", code: "api-overloaded" };
    case "transient_disconnect": return { kind: "provider-error", code: "transient-disconnect" };
    case "stream_stalled": return { kind: "provider-error", code: "stream-stalled" };
    case "aborted":
    case "context_overflow":
    case "output_overflow":
    case "model_unavailable":
    case "local_persistence_error":
      return { kind: "failed", code: "runner-failed" };
  }
}
/** Runs one production Chat prompt. The deadline requests cancellation; return awaits runner, host, and owned-background settlement. */
export async function runChatRoutingTask(deps: ChatRoutingDeps, request: ChatRoutingRequest): Promise<ChatRoutingOutcome> {
  if (!Number.isFinite(request.deadlineMs) || request.deadlineMs <= 0) throw new Error("Chat routing requires a finite positive deadlineMs");
  let runner: Agent | undefined;
  let firstPersona: string | undefined;
  let firstInvalidEvidence: string | undefined;
  const usage = createBenchmarkAccounting();
  let timedOut = false;
  let cancelled = request.signal?.aborted ?? false;
  const startedAt = performance.now();
  const accounting = () => ({ durationMs: Math.round(performance.now() - startedAt), accounting: usage.observe() });
  const intercept = async (input: Readonly<DispatchInput>, tasks: ModuleAgentTasks) => {
    const validation = tasks.validate(input, request.agentRegistry);
    if (!validation.ok) {
      const evidence = safeInvalidEvidence(input);
      firstInvalidEvidence ??= evidence;
      deps.onInvalidDispatch?.(evidence);
      return { content: "The benchmark rejected the invalid subagent dispatch.", outcome: "error" as const };
    }
    firstPersona ??= validation.agentType;
    queueMicrotask(() => runner?.abort());
    return { content: "The benchmark captured the subagent dispatch without constructing a child.", outcome: "ok" as const };
  };
  const moduleSelection = (): FirstPartyModuleComposition => routingComposition(request.moduleSelection(), intercept);
  const host = createAgentHost({ createRunner: deps.createAgent });
  const timer = setTimeout(() => { timedOut = true; runner?.abort(); }, request.deadlineMs);
  const abort = (): void => { cancelled = true; runner?.abort(); };
  request.signal?.addEventListener("abort", abort, { once: true });
  let terminal: AgentRunTerminal | undefined;
  try {
    const result = await host.runTurn({
      createContextOptions: () => ({
        model: request.model,
        effort: request.effort,
        purpose: { kind: "chat-routing-benchmark" },
        executionCwd: request.workspace,
        projectRoot: request.workspace,
        userDataRoot: request.userDataRoot,
        accountHome: request.accountHome,
        onEvent: (event: RuntimeEvent) => {
          if (event.type !== "model.usage.measured") return;
          usage.commit(event.data.usage_entry);
        },
        agentRegistry: request.agentRegistry,
        skills: request.skills,
        moduleSelection,
        runtimeSurfaces: request.runtimeSurfaces,
        conversation: { kind: "stateless" },
        lifecycle: { kind: "one-shot" },
      }),
      onContextCreated: (context) => { runner = context; if (cancelled || timedOut) context.abort(); },
      message: request.prompt,
      resilience: {},
    });
    terminal = result.terminal;
  } catch {
    const observed = accounting();
    if (timedOut) throw new ChatRoutingFailure({ kind: "timed-out", timeoutMs: request.deadlineMs }, observed.durationMs, observed.accounting);
    if (cancelled) throw new ChatRoutingFailure({ kind: "cancelled" }, observed.durationMs, observed.accounting);
    throw new ChatRoutingFailure({ kind: "failed", code: "unexpected-error" }, observed.durationMs, observed.accounting);
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", abort);
    await host.settle();
    await deps.closeOwnedBackground?.();
  }
  const observed = accounting();
  if (timedOut) throw new ChatRoutingFailure({ kind: "timed-out", timeoutMs: request.deadlineMs }, observed.durationMs, observed.accounting);
  if (cancelled) throw new ChatRoutingFailure({ kind: "cancelled" }, observed.durationMs, observed.accounting);
  if (!firstPersona && terminal && terminal.kind !== "completed") {
    const failure = failureFromTerminal(terminal) ?? { kind: "failed" as const, code: "runner-failed" as const };
    throw new ChatRoutingFailure(failure, observed.durationMs, observed.accounting);
  }
  if (firstPersona) return { kind: "dispatch", persona: firstPersona, ...observed };
  return firstInvalidEvidence
    ? { kind: "invalid-dispatch", evidence: firstInvalidEvidence, ...observed }
    : { kind: "no-valid-dispatch", ...observed };
}
