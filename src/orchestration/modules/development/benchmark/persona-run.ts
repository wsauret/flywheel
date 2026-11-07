import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentDefinition } from "../../../../infra/agent-definition.js";
import { errorMessage } from "../../../../infra/error-message.js";
import { DURABLE_RUNTIME_EVENT_TYPES, type RuntimeEvent } from "../../../../infra/runtime-event-types.js";
import type { Effort } from "../../../../infra/workflow-types.js";
import { agentTasksFromComposition, type ModuleAgentTasks } from "../../../module-agent-tasks.js";
import { composeFirstPartyModules } from "../../../modules.js";
import type { WorkflowDeps } from "../../../workflow-host/deps.js";
import type { LauncherScope } from "../../../../infra/process-supervisor.js";
import type { BackgroundExecutionOwner } from "../../../agent-runtime/background-execution-owner.js";
import type { ShellRuntimeClient } from "../../../agent-runtime/tools/shell-runtime-types.js";
import type { ForegroundBashHoldController } from "../../../agent-runtime/foreground-bash-hold.js";
import { formatAgentFailure } from "../../../agent-runtime/failure-message.js";
import { failureTerminal, type AgentRunResult } from "../../../agent-runtime/types.js";
import { personaInstructions } from "../../../../workflows/agents/persona-instructions.js";
import { grantedSubagentTypes, personaToolNames } from "../../../../workflows/agents/subagent-reachability.js";
import type { AttemptTerminal } from "./run-store.js";
import { createBenchmarkAccounting } from "./accounting.js";
import { unavailableBenchmarkAccounting, type BenchmarkAccounting } from "./evidence.js";
import { invokeBenchmarkAgent } from "./invocation.js";
import { agentCapabilityCheck } from "../../../agent-runtime/capability-checks.js";
import { availableToolNames } from "../../../agent-runtime/persona-tool-rules.js";
import { definitionAvailabilityOf } from "../../../app-service/definition-availability.js";
import type { CaptureProviderConnection } from "../../../agent-runtime/factory.js";
import { resolveSessionRoles } from "../../../config/session-role-resolver.js";

export type PersonaDefinition = Extract<AgentDefinition, { kind: "persona" }>;

/** The events a session store would record for this run: the product's own definition of its durable transcript. */
const DURABLE_EVENT_TYPES: ReadonlySet<RuntimeEvent["type"]> = new Set(DURABLE_RUNTIME_EVENT_TYPES);

/** Runtime surface one benchmark cell needs: the composed provider state its
 *  runner is built from, the definitions it composes personas and skills out
 *  of, and the owned-command runner its sandboxes use. A standalone CLI passes
 *  its whole WorkflowDeps; an embedded caller passes the parent runtime's
 *  captured state, which is a structural subset of the same shape and carries
 *  no config, auth, or refresh authority it does not own. */
export type BenchmarkRuntime = Pick<
  WorkflowDeps,
  "userDataRoot" | "accountHome" | "definitions" | "createAgent" | "createLLMClient" | "runOwnedCommand" | "moduleSelection"
> & {
  readonly profileId?: string;
  readonly authorityIncarnation?: string;
  readonly captureProviderConnection?: CaptureProviderConnection;
  readonly launcher?: LauncherScope;
  readonly background?: BackgroundExecutionOwner;
  readonly foregroundBashHold?: ForegroundBashHoldController;
  readonly shell?: ShellRuntimeClient;
  /** Nonsecret capture fingerprints that a native process must match before it creates a candidate. */
  readonly admissionIdentity?: {
    readonly runtimeConfig: string;
  };
};

/** The (model, effort) pair a persona runs on for one benchmark cell. */
interface PersonaSeat {
  model?: string;
  effort?: Effort;
}

interface PersonaHandoff {
  [field: string]: unknown;
}

export interface PersonaRunOutcome {
  accounting: BenchmarkAccounting;
  durationMs: number;
  /** The structured handoff content, when the persona called the handoff tool. */
  handoff: PersonaHandoff | undefined;
  /** Handoff JSON plus final assistant text; the judged artifact. */
  summary: string;
}

/** What a cell spent before it settled without a result. Each measurement is
 *  independent: a run can report usage and still lack provider attribution. */
export interface PersonaRunAccounting {
  durationMs: number;
  accounting: BenchmarkAccounting;
}

/** The one way a cell reports that it produced no run. It carries the typed
 *  terminal reason and the accounting, so the caller persists an attempt row
 *  without parsing a message to learn what happened. */
export class PersonaTaskFailure extends Error {
  constructor(
    readonly terminal: AttemptTerminal,
    readonly accounting: PersonaRunAccounting,
    message: string,
  ) {
    super(message);
    this.name = "PersonaTaskFailure";
  }
}

/** A cell can also settle unsuccessfully outside its persona run: provisioning
 *  its workspace, or capturing the diff it produced. Such an error becomes a
 *  failure accounted the same way, with the measurements nobody took reported
 *  as unavailable; a failure the persona run reported passes through. After
 *  `signal` fired, the error is the cancellation's own doing: the stop
 *  refuses the cell's next command and ends the one in flight. So the cell
 *  records that it was cancelled, as a cell stopped in its persona run does. */
export function asPersonaTaskFailure(error: unknown, startedAt: number, signal: AbortSignal | undefined): PersonaTaskFailure {
  if (error instanceof PersonaTaskFailure) return error;
  const message = errorMessage(error);
  return new PersonaTaskFailure(signal?.aborted ? { kind: "cancelled" } : { kind: "failed", message }, {
    durationMs: Math.round(performance.now() - startedAt),
    accounting: unavailableBenchmarkAccounting("the cell stopped outside its persona run"),
  }, message);
}

function describeTerminal(terminal: AttemptTerminal): string {
  switch (terminal.kind) {
    case "failed":
      return `failed: ${terminal.message}`;
    case "timed-out":
      return `timed out after ${terminal.timeoutMs} ms`;
    case "cancelled":
      return "was cancelled";
  }
}

/** One benchmark cell: which persona runs on which seat, against what, where.
 *  `label` names the cell in error messages (e.g. "explorer/session-disposal/0").
 *  `workspace` is the trial's whole project: both the project root and the
 *  execution directory, so project instructions, memory, and tools all read it. ARCH-DIRECTORIES-015.
 *  `timeoutMs` and `signal` each bound the cell: the runner is aborted, its
 *  settlement awaited, and the reason reported. */
export interface PersonaTaskRequest {
  persona: PersonaDefinition;
  seat: PersonaSeat;
  prompt: string;
  label: string;
  workspace: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  agentRegistry?: ReadonlyMap<string, AgentDefinition>;
  /** Native transports observe readiness and stop to bound startup and settlement without reducing the actor deadline. */
  onPhase?: (phase: "ready" | "settling") => void;
  /** Benchmark turns are stateless, so no session store records them. When set, the run's durable runtime events are
   *  written here as JSON lines after settlement, on success and failure alike. A write failure never changes the outcome. */
  transcriptPath?: string;
}

export interface PersonaTaskGuidance {
  readonly task: string;
  readonly toolNames: readonly string[];
}

/** Renders the exact system task sent to a persona runner. Campaign identity
 * uses this same function, so skill or persona guidance cannot drift silently.
 * The persona's tools narrow to the runtime's modules and its instructions
 * render for that grant, as a subagent dispatch of it does. */
export function renderPersonaTaskGuidance(
  persona: PersonaDefinition,
  agentRegistry: ReadonlyMap<string, AgentDefinition>,
  runtime: Pick<BenchmarkRuntime, "definitions" | "moduleSelection">,
  tasks: ModuleAgentTasks = installedAgentTasks(),
): PersonaTaskGuidance {
  const modules = runtime.moduleSelection();
  const revision = runtime.definitions.captureRevision();
  const toolNames = availableToolNames(personaToolNames(persona, agentRegistry), modules);
  const has = agentCapabilityCheck(new Set(toolNames), definitionAvailabilityOf(revision, modules.enabledModuleIds));
  return {
    task: tasks.task(personaInstructions(persona, revision.skills, has), has, persona.maxTurns),
    toolNames,
  };
}

function installedAgentTasks(): ModuleAgentTasks {
  const tasks = agentTasksFromComposition(composeFirstPartyModules())
  if (!tasks) throw new Error("No installed module provides agent task guidance")
  return tasks
}

/** Run one persona once against one prompt using the production agent runtime.
 *  Throws `PersonaTaskFailure` for every unsuccessful settlement, including a
 *  failure after partial output, so the partial accounting survives. */
export async function runPersonaTask(deps: BenchmarkRuntime, request: PersonaTaskRequest): Promise<PersonaRunOutcome> {
  const { persona, seat, label, timeoutMs, signal } = request;
  const { transcriptPath } = request;
  const captureProviderConnection = deps.captureProviderConnection;
  const usage = createBenchmarkAccounting();
  const tasks = installedAgentTasks();
  const observer = tasks.observe(persona.name);
  const transcript: string[] = [];
  const onEvent = (event: RuntimeEvent): void => {
    if (event.type === "model.usage.measured") {
      usage.commit(event.data.usage_entry);
    }
    if (request.transcriptPath && DURABLE_EVENT_TYPES.has(event.type)) transcript.push(JSON.stringify(event));
    observer.onEvent(event);
  };
  let capturedHandoff: PersonaHandoff | undefined;
  const skills = deps.definitions.skills();
  const agentRegistry = request.agentRegistry ?? new Map<string, AgentDefinition>();
  const allowedSubagentTypes = grantedSubagentTypes(persona, agentRegistry);
  const { task, toolNames } = renderPersonaTaskGuidance(persona, agentRegistry, deps, tasks);
  let stop: AttemptTerminal | undefined;
  request.onPhase?.("ready");
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
    stop ??= { kind: "timed-out", timeoutMs };
    request.onPhase?.("settling");
  }, timeoutMs);
  const onAbort = (): void => {
    stop ??= { kind: "cancelled" };
    request.onPhase?.("settling");
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const runPromise = invokeBenchmarkAgent({
    createAgent: deps.createAgent,
    runtimeSurfaces: {
      handoff: { onContent: (content) => { capturedHandoff = content; }, schema: tasks.handoffSchema },
      ...(deps.launcher ? { launcher: deps.launcher } : {}),
      ...(deps.background ? { background: deps.background } : {}),
      ...(deps.foregroundBashHold ? { foregroundBashHold: deps.foregroundBashHold } : {}),
      ...(deps.shell ? { shell: deps.shell } : {}),
    },
    agentOptions: {
      model: seat.model,
      effort: seat.effort,
      ...(captureProviderConnection ? {
        captureProviderConnection,
        resolveRoles: async (captured) => {
          const capture = captured ?? await captureProviderConnection();
          const roles = await resolveSessionRoles({
            defaults: {}, overrides: seat.model === undefined && seat.effort === undefined ? {} : { [persona.role]: seat },
          }, capture, deps.userDataRoot, [persona.role]);
          if (transcriptPath) {
            const directory = dirname(transcriptPath);
            const requests = join(directory, "requests", capture.connection.profileId);
            await mkdir(requests, { recursive: true });
            const text = JSON.stringify(Object.fromEntries([...roles].map(([id, role]) => [id, { model: role.model, effort: role.effort }])), null, 2);
            await Bun.write(join(requests, `${crypto.randomUUID()}.json`), text);
            await Bun.write(join(directory, "roles.json"), text);
          }
          return roles;
        },
        requestSelection: (roles) => ({ roleId: persona.role, ...roles.get(persona.role) }),
      } : {}),
      purpose: { kind: "persona-benchmark" },
      executionCwd: request.workspace,
      projectRoot: request.workspace,
      userDataRoot: deps.userDataRoot,
      accountHome: deps.accountHome,
      onEvent,
      toolNames,
      ...(deps.profileId ? { activeProfileId: deps.profileId } : {}),
      maxLLMCalls: persona.maxTurns,
      skills,
      allowedSubagentTypes,
      agentRegistry,
    },
    // The task follows the assignment in the opening turn, as a dispatched
    // subagent's does.
    prompt: `${request.prompt}\n\n${task}`,
    ...(signal ? { signal } : {}),
    ...(timeoutMs === undefined ? {} : { deadlineMs: timeoutMs }),
  });

  const startedAt = performance.now();
  const accounting = (): PersonaRunAccounting => {
    return {
      durationMs: Math.round(performance.now() - startedAt),
      accounting: usage.observe(),
    };
  };
  const fail = (terminal: AttemptTerminal): PersonaTaskFailure =>
    new PersonaTaskFailure(terminal, accounting(), `${label} ${describeTerminal(terminal)}`);

  // The first cause wins: a timeout that already aborted the runner is not
  // reclassified by the cancellation its own abort may raise.
  // Aborting only asks the runner to stop. Awaiting `runner.done` is what makes
  // the reported duration a measurement of a settled run.
  let run: AgentRunResult | undefined;
  let settlementError: unknown;
  try {
    run = await runPromise;
  } catch (error) {
    settlementError = error;
  } finally {
    request.onPhase?.("settling");
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if (transcriptPath) {
      // The transcript is diagnostic evidence only; a full disk must not turn a scored cell into a failure.
      await mkdir(dirname(transcriptPath), { recursive: true }).then(() => Bun.write(transcriptPath, transcript.map((line) => `${line}\n`).join(""))).catch(() => {});
    }
  }
  const failure = run === undefined
    ? undefined
    : run.terminal.kind === "interrupted" || run.terminal.kind === "input_closed"
      ? { kind: "aborted" as const }
      : failureTerminal(run.terminal);
  // A run that produced its result before the stop arrived is complete: the
  // work is done and discarding it would lose a paid cell.
  if (run === undefined || failure) {
    if (stop) throw fail(stop);
    if (failure) throw fail({ kind: "failed", message: formatAgentFailure(failure) });
    throw fail({ kind: "failed", message: errorMessage(settlementError) });
  }
  const durationMs = Math.round(performance.now() - startedAt);
  // Score the full handoff JSON plus the final assistant text for every
  // persona. Handoffs put findings in structured fields beyond `summary`
  // (a terse summary is correct handoff style), and models differ in how
  // much they pack into `summary`; judging only that field systematically
  // penalizes disciplined handoff writers.
  const summary = [
    capturedHandoff ? JSON.stringify(capturedHandoff, null, 1) : "",
    observer.finalAssistantText().trim(),
  ].filter(Boolean).join("\n\n");
  if (!summary) throw fail({ kind: "failed", message: `ended as ${run.terminal.kind} without a summary` });

  return {
    accounting: usage.observe(),
    durationMs,
    handoff: capturedHandoff,
    summary,
  };
}
