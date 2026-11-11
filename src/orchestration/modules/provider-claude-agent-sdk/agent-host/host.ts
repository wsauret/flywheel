import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Cause, Effect, Exit, Queue } from "effect";
import { DebugLog } from "../../../../infra/debug-log.js";
import type { ModelRefusal } from "../../../../infra/auth/provider-model-catalog-store.js";
import { asRecord } from "../../../../infra/record.js";
import { classifyAnthropicError } from "../../../agent-runtime/llm/anthropic-adapter-helpers.js";
import { LlmStreamError, ModelAccessRefusedError, QuotaCoordinationError, QuotaExhaustedError } from "../../../agent-runtime/llm/errors.js";
import { STREAM_TTFT_TIMEOUT_MS } from "../../../agent-runtime/llm/stream-watchdog.js";
import type { ProviderTransportHiddenRequest } from "../../../session/provider-request-audit-types.js";
import type { UsageWindows } from "../account-usage.js";
import { usageReports, type ExtraUsage, type ExtraUsageStop, type GuardStop } from "../extra-usage-guard.js";
import { EngineCannotStartError } from "../login-observations.js";
import { observeEngine } from "../observed-engine.js";
import type { CliUserFrame, HostLaunch, LaunchedHost } from "../query-launcher.js";
import { classifySdkMessage, cliFailure, reportsSpentUsage, type CliErrorReport, type CliTurnResult, type QuotaMark } from "../sdk-events.js";
import { wireFailure, type WireFailure } from "../service-requests.js";
import { bridgeSessionId } from "../session-id.js";
import { stepGateFailure, type PluginGateServer } from "../step-gate.js";
import { createToolGate, type ToolGate } from "../tool-gate.js";
import { silentDebugOutputFailure, type SilentVersions } from "../stderr-signals.js";
import { lockSession, sweepLeftBehindSessions, transcriptFiles } from "../transcript.js";
import { queueIterable } from "../queue-iterable.js";
import { CLAUDE_AGENT_SDK_LABEL, TOOL_MCP_PREFIX } from "../names.js";
import { hostSessionFolder, type AgentFolder } from "./agent-file.js";
import { DISPATCH_MESSAGE } from "./engine-text.js";
import { AGENT_HOST_PLUGIN, AGENT_HOST_SOCKET_VARIABLE, createHostGate, serveHostGate, type AgentAdmission, type AgentStepSink, type HostGate, type StepValues } from "./host-gate.js";
import { COORDINATOR_EFFORT, type Coordinator, type HostValues } from "./host-registry.js";
import { hostedRequests } from "./hosted-requests.js";

/** The dispatcher's whole prompt. It is the same for every host, so its cache entry serves every frame. */
const DISPATCHER_PROMPT = `You start background agents. Each message names agent ids after "agents:". For each id, call SendMessage once with "to" set to that id and "message" set to exactly "${DISPATCH_MESSAGE}". Make every call in one response. When the results arrive, answer with the single word "Sent".`;
/** How many frames may miss one agent before its dispatch fails. */
const DELIVERY_TRIES = 3;

/** How a hosted agent's task ended, as the engine reports it. */
export type TaskEnd = "completed" | "failed" | "stopped";

/** Why the host denied a dispatcher's message to an agent, with the error text that the dispatcher's model reads: its
 *  target is not an agent of the frame, the dispatcher sent the agent a second message, or the message is not
 *  `DISPATCH_MESSAGE`. */
const DENIALS = {
  foreign: "This id is not one that the current message names. Send only to the ids that it names.",
  duplicate: "This agent already has its message. Do not send it again.",
  changed: `Send exactly "${DISPATCH_MESSAGE}" as the message.`,
} as const;

/** Why Flywheel stopped a hosted agent's task, which its `task_stopped` record names:
 *  - `abort`: a person's or a parent's stop of the agent's session, while a step streams or the agent waits on a tool.
 *  - `lifetime-end`: the agent's client ended without a stop: its session ended, such as at its handoff, or a new model
 *    selection replaced the client, while the agent waits in a call's handler.
 *  - `host-ended`: the agent's host closed before the agent's next request.
 *  - `moved-host`: the agent's request moves it to the host of its new launch values.
 *  - `restarted`: the agent's request starts it again from its own history.
 *  - `own-engine`: the agent's request goes to its own engine, because no host can serve it.
 *  - `request-failed`: the agent's request failed.
 *  - `dispatch-failed`: the dispatch of the agent failed or was withdrawn. */
export type StopCause = "abort" | "lifetime-end" | "host-ended" | "moved-host" | "restarted" | "own-engine" | "request-failed" | "dispatch-failed";

/** What one host tells the bridge of one of its agents. Each callback returns at once. */
interface AgentListener {
  /** The engine ended the agent's task, or the host ended it with `error`. */
  ended(end: TaskEnd, error?: Error): void;
  /** The gate refused a step of the agent, so the engine holds a turn that Flywheel did not send. */
  refused(): void;
}


/** One shared agent host: one engine process whose dispatcher starts and resumes the agents of one chat tree that
 *  share its launch values (`HostKey`). */
export interface AgentHost {
  readonly sessionId: string;
  readonly folder: AgentFolder;
  readonly toolGate: ToolGate;
  /** The agent type of the definition with `systemPrompt` on `model`, in the engine's spelling, which the host writes
   *  when it is new. The engine runs each agent on its definition's model and names that model in the agent's text. */
  definition(systemPrompt: string, model: string): string;
  /** Admits the agent's next step (`HostGate.admit`), after the host settled the usage report that an earlier complete
   *  response of its engine owes (`UsageReports.settle`). It rejects instead, and closes the host, when the extra-usage
   *  guard stops the account, with the stop's error, or when Flywheel cannot read the debug output of the engine's
   *  version, with `silentDebugOutputFailure`. */
  admit(agentId: string, values: StepValues, sink: AgentStepSink): Promise<AgentAdmission>;
  /** Starts or resumes the agent from its file through the next dispatch frame. Resolves when the engine started the
   *  agent's task; rejects when the dispatcher's request failed, the dispatch was withdrawn, or the agent missed
   *  `DELIVERY_TRIES` frames. */
  dispatch(agentId: string, listener: AgentListener): Promise<void>;
  /** The hidden requests for the agent's next transport record (ARCH-CONTEXT-008): the dispatcher's requests that no
   *  record holds yet, which the next record of any agent of the host takes, and the requests that the agent sent
   *  without an admitted step (`HostedRequests.takeHidden`). The host adds a frame's requests when the frame ends, so
   *  no request waits for them. */
  takeHiddenRequests(agentId: string): readonly ProviderTransportHiddenRequest[];
  /** The transport of the agent's current step was consumed: its stream ended, or its consumer left it. With the end
   *  of the agent's task, the host forgets the agent's requests (`HostedRequests.released`). */
  released(agentId: string): void;
  /** The failure of the agent's step that ended without its stop, from the record of its request
   *  (`HostedRequests.failure`). */
  requestFailure(agentId: string): Promise<Error>;
  /** Waits until the engine ended the agent's running task, or at once when it runs none. */
  settled(agentId: string): Promise<void>;
  /** Stops the agent's task, or the task that its dispatch would start, and withdraws a dispatch that waits for a frame;
   *  no other agent changes. The one record of the stop names the bridge's `cause` and the error `reason` that ended
   *  the agent's request, when one did. The withdrawn dispatch rejects with `reason`. A closed host stopped every task
   *  with its close, so a stop then records nothing and asks the engine nothing. */
  stopTask(agentId: string, cause: StopCause, reason?: Error): void;
  /** Resolves with the error that ended the host: its engine exited or the host closed. */
  readonly ended: Promise<Error>;
  /** The engine started the task of an agent, so the host served a request. */
  readonly served: boolean;
  /** Closes the gate, so no step of the host reaches the service, and ends the engine. `error` fails what waits on
   *  the host. Resolves when the engine stopped; a later call resolves with the first close. */
  close(reason: string, error?: Error): Promise<void>;
}

/** What one host is: its login and launcher, where it runs, and the request values that its engine fixes. */
export interface AgentHostConfig {
  readonly launchHost: (launch: HostLaunch) => LaunchedHost;
  readonly configDir: string;
  /** The real path of the host's working directory: the tree root's directory, or an agent's directory when its git
   *  status differs from the tree root's. Each agent runs in the directory that its meta file states
   *  (`AgentFileInput.cwd`), not here. */
  readonly cwd: string;
  readonly values: HostValues;
  /** The models of the host's coordinator in the order in which it tries them (`coordinatorCandidates`). The host
   *  launches on the first. */
  readonly coordinators: readonly [Coordinator, ...Coordinator[]];
  readonly markQuotaExhausted: QuotaMark;
  /** Records that the login refuses `wireModelId`. Returns at once and never fails. */
  readonly recordModelRefusal: (wireModelId: string, refusal: ModelRefusal) => void;
  /** Whether the login may serve from extra usage, which the host's usage guard reads (`usageReports`). */
  readonly extraUsage: ExtraUsage;
  /** Whether the engine's usage reports of the login state extra usage, read when the host opens. */
  readonly reportsExtraUsage: boolean;
  /** Tells the person about a stop of the host's usage guard, through the notify port of the composition whose
   *  client opened the host. It returns at once and never fails. */
  readonly onExtraUsageStop: (stop: ExtraUsageStop) => void;
  /** Records the plan windows that a usage report names. It returns at once and never fails. */
  readonly recordUsage: (windows: UsageWindows) => void;
  /** How long the dispatcher of an open frame may make no progress (`openAgentHost`) before the host closes as
   *  stalled. Defaults to the first-event deadline of a model stream (`STREAM_TTFT_TIMEOUT_MS`), because the dispatcher
   *  emits only complete messages, so each gap holds a whole response; a test gives a short one. */
  readonly dispatcherStepDeadlineMs?: number;
  /** The engine versions whose debug output Flywheel cannot read, which the process shares with its chat bridges. */
  readonly silentVersions: SilentVersions;
  /** How long a failed step waits for its record (`hostedRequests`); a test gives a short one. */
  readonly recordBoundMs?: number;
}

interface Pending {
  readonly agentId: string;
  readonly listener: AgentListener;
  readonly started: PromiseWithResolvers<void>;
  tries: number;
}

interface Frame {
  readonly uuid: string;
  readonly nonce: string;
  readonly batch: readonly Pending[];
  /** The agents to which the host let the dispatcher send its message in this frame. */
  readonly sent: Set<string>;
  /** The ids of the frame's complete dispatcher messages, each of which the gate must have admitted. The engine sends
   *  one SDK message for each content block of a response, all with the response's id. */
  readonly messages: Set<string>;
  /** The engine's report of a dispatcher request of the frame that failed, which it sends as its own synthetic
   *  message: progress evidence, and the text of a refusal for the login's spent usage. */
  report: CliErrorReport | undefined;
  /** The frame's stall deadline, armed from its turn's open until its turn result. */
  watchdog: ReturnType<typeof setTimeout> | undefined;
}

/** Opens one host. The engine starts at once; the first dispatch frame waits for nothing but the engine.
 *
 *  Each frame has a watchdog. It arms when the frame's turn opens and arms again at each dispatcher step that the
 *  gate admits and at each complete dispatcher message; the frame's turn result disarms it. When the dispatcher
 *  makes no progress within `dispatcherStepDeadlineMs`, the host closes with reason `dispatcher-stalled`: every
 *  dispatch that waits fails as transient, and the registry opens a new host for the next lease. A dispatcher request
 *  that the engine itself ends with an error ends the frame through its turn result, which fails only that frame's
 *  dispatches and keeps the host. */
export function openAgentHost(config: AgentHostConfig): AgentHost {
  // A tagged id, so that a sweep finds what a crash leaves of the host's session (`sweepLeftBehindSessions`).
  const sessionId = bridgeSessionId();
  const folder: AgentFolder = { configDir: config.configDir, cwd: config.cwd, sessionId };
  const listeners = new Map<string, AgentListener>();
  const running = new Map<string, PromiseWithResolvers<void>>();
  /** Running tasks that the host asked the engine to stop, so that it asks once. */
  const stopping = new Set<string>();
  const queued: Pending[] = [];
  const inFlight = new Map<string, Pending>();
  /** Agents whose dispatch was withdrawn after its frame went out: the engine still starts their tasks, and the host
   *  stops each one when its task starts. */
  const stopOnStart = new Set<string>();
  const definitions = new Set<string>();
  let reloadNeeded = false;
  let frame: Frame | undefined;
  let conversationStart: string | undefined;
  /** A cut of the dispatcher's conversation, or the decision on a failed frame, is running, so no frame goes out until
   *  it settles. */
  let cutting = false;
  let frames = 0;
  let served = false;
  let closed = false;
  const ended = Promise.withResolvers<Error>();
  /** The model on which the coordinator runs now, and the models that it tries after it. */
  let coordinator = config.coordinators[0];
  let fallbacks = config.coordinators.slice(1);
  let cliVersion: string | undefined;
  // One engine process sends a usage report after its first complete response and then only on a change, so the
  // host's one guard reads the reports of every agent and of the dispatcher (bridge rule 14).
  const reports = usageReports({
    extraUsage: config.extraUsage, reportsExtraUsage: config.reportsExtraUsage, sessionId,
    markQuotaExhausted: config.markQuotaExhausted, onStop: config.onExtraUsageStop, recordUsage: config.recordUsage,
  });
  const requests = hostedRequests({
    sessionId, silentVersions: config.silentVersions, cliVersion: () => cliVersion, dispatcherServed: () => { reports.served(); },
    ...(config.recordBoundMs === undefined ? {} : { recordBoundMs: config.recordBoundMs }),
  });
  /** The host's one settlement of the usage report that a complete response of its engine owes, before any step of
   *  the engine sends and before the engine stops (`UsageReports.settle`, whose callers share one decision). A stop
   *  closes the host and is returned. */
  const settleUsage = async (): Promise<GuardStop | undefined> => {
    const usageStop = await Effect.runPromise(reports.settle());
    if (usageStop !== undefined) void close("extra-usage", usageStop.error);
    return usageStop;
  };
  /** Closes the host when its engine's version is one whose debug output Flywheel cannot read, as this host or any
   *  other engine of the process found, and returns the failure; undefined while the version serves. The host checks
   *  when its engine names its version and before each step that it admits, because another engine can find the
   *  version silent while this host is open. */
  const refusesSilent = (): Error | undefined => {
    if (cliVersion === undefined || !config.silentVersions.has(cliVersion)) return undefined;
    const failure = silentDebugOutputFailure(cliVersion);
    void close("debug-output", failure);
    return failure;
  };
  // The dispatcher's steps send at the coordinator's effort, or with none when the agents' requests state no effort,
  // and on the coordinator's model once a failure moved it from the launch model.
  const gate: HostGate = createHostGate({
    dispatcherValues: () => ({
      ...(config.values.statesEffort ? { effort: COORDINATOR_EFFORT } : {}),
      ...(coordinator === config.coordinators[0] ? {} : { model: coordinator.model }),
    }),
    dispatcherAdvanced: (nonce) => { if (frame?.nonce === nonce) watch(frame); },
    dispatcherAsked: (nonce) => { requests.dispatcherAsked(nonce); },
    agentAdmitted: (agentId) => { requests.admitted(agentId); },
    settled: async () => (await settleUsage()) === undefined,
    refused: (step) => {
      if (step.agentId === undefined) return;
      DebugLog.record({ type: "provider.claude_sdk.host.step_refused", payload: { sessionId, agentId: step.agentId, index: step.index } });
      listeners.get(step.agentId)?.refused();
    },
  });
  sweepLeftBehindSessions(config.configDir, config.cwd);
  // The host owns its session's folder from before its engine writes it until its close deleted it. A host that
  // cannot open releases the lock and its gate at once: its engine wrote nothing.
  const unlock = lockSession(config.configDir, sessionId);
  let server: PluginGateServer;
  try {
    server = serveHostGate(gate);
  } catch (error) {
    unlock();
    throw error;
  }
  mkdirSync(join(server.pluginPath, "agents"), { recursive: true });
  const toolGate = createToolGate(config.values.tools);
  const prompt = Effect.runSync(Queue.unbounded<CliUserFrame, Error | Cause.Done>());
  // The observer's calls come after this function returns, because the engine's SDK stream yields nothing at once.
  const { launched } = observeEngine((onStderrLine) => {
    try {
      return config.launchHost({
        ...config.values, model: config.coordinators[0].model, prompt: queueIterable(prompt, undefined), mcpServer: toolGate.server,
        cwd: config.cwd, sessionId, dispatcherPrompt: DISPATCHER_PROMPT, refuseDispatch: (input) => refuseDispatch(input),
        gate: { socketVariable: AGENT_HOST_SOCKET_VARIABLE, socketPath: server.socketPath, pluginPath: server.pluginPath },
        onStderrLine,
      });
    } catch (error) {
      server.close();
      unlock();
      throw error;
    }
  }, (host) => host.messages, {
    message: (message) => { read(message); },
    debugLine: (line) => { requests.read(line); },
    // An engine that could not start fails as a route that is down, so the request goes to the next candidate.
    ended: (error) => {
      reports.arrived(undefined);
      void close("engine-exited", launched.process.cannotStart() ? new EngineCannotStartError()
        : new LlmStreamError(`The ${CLAUDE_AGENT_SDK_LABEL} agent host's engine stopped${error === undefined ? "" : `: ${error instanceof Error ? error.message : String(error)}`}`, "transient"));
    },
  }, { role: "host", sessionId, model: config.coordinators[0].model, coordinators: config.coordinators.length, tools: config.values.tools.length });

  const fail = (pending: Pending, error: Error) => {
    pending.started.reject(error);
    listeners.delete(pending.agentId);
  };

  const dispatcherStepDeadlineMs = config.dispatcherStepDeadlineMs ?? STREAM_TTFT_TIMEOUT_MS;
  /** Arms the watchdog of `watched` again from now. */
  const watch = (watched: Frame) => {
    clearTimeout(watched.watchdog);
    watched.watchdog = setTimeout(() => {
      // The steps that the gate admitted and the messages that arrived tell a stall before the dispatcher's first
      // answer from one between its steps.
      DebugLog.record({ type: "provider.claude_sdk.host.dispatcher_stalled", payload: {
        sessionId, agents: watched.batch.length, admittedSteps: gate.dispatcherSteps(watched.nonce), messages: watched.messages.size, deadlineMs: dispatcherStepDeadlineMs,
      } });
      void close("dispatcher-stalled", new LlmStreamError(`The ${CLAUDE_AGENT_SDK_LABEL} agent host's dispatcher made no progress for ${dispatcherStepDeadlineMs} ms`, "transient"));
    }, dispatcherStepDeadlineMs);
  };

  const sendFrame = async () => {
    if (frame !== undefined || cutting || queued.length === 0 || closed) return;
    const batch = queued.splice(0);
    const next: Frame = { uuid: randomUUID(), nonce: gate.nonce(), batch, sent: new Set(), messages: new Set(), report: undefined, watchdog: undefined };
    requests.frameOpened(next.nonce);
    frame = next;
    for (const pending of batch) inFlight.set(pending.agentId, pending);
    if (reloadNeeded) {
      reloadNeeded = false;
      await launched.reloadPlugins();
      DebugLog.record({ type: "provider.claude_sdk.host.plugins_reloaded", payload: { sessionId, definitions: definitions.size } });
    }
    conversationStart ??= next.uuid;
    Queue.offerUnsafe(prompt, { type: "user", uuid: next.uuid, message: { role: "user", content: [{ type: "text", text: `${next.nonce}\nagents: ${batch.map(({ agentId }) => agentId).join(" ")}` }] }, parent_tool_use_id: null });
  };
  const kick = () => { sendFrame().catch((error: unknown) => { void close(`frame-failed:${error instanceof Error ? error.name : typeof error}`); }); };

  /** Moves the coordinator off its model after its request failed with the service's answer `wire`, when the failure
   *  is one of the model or the login's use of it, as the native classification reads that answer: the service refuses
   *  the model (`ModelAccessRefusedError`) or refuses the login the model (403). A rate limit is `undefined`: it is
   *  throttling of the whole login that clears as other requests finish (PI-MODEL-060), so the frame's agents fail with
   *  the service's answer and its retry delay, and the failover client's retry owns the wait. The failure
   *  is the coordinator's alone, so neither the login nor the account's quota is marked, and no agent's model is
   *  refused. A model that the service refuses is recorded as one that the login refuses, so later hosts skip it. The
   *  coordinator goes to its next model (`demoted`), and the frame's agents go into the next frame. When no model
   *  remains (`exhausted`), the frame's agents fail as transient, so their requests retry and then fail over, and the
   *  coordinator starts again at its first model, so a host that outlives a short outage recovers. Any other failure,
   *  such as a 404 of another resource, is `undefined`. `report` adds the engine's error kind to the record only. */
  const demote = (wire: WireFailure, report: CliErrorReport | undefined): "demoted" | "exhausted" | undefined => {
    const classified = classifyAnthropicError(wireFailure(wire));
    const refused = classified instanceof ModelAccessRefusedError;
    if (!refused && wire.status !== 403) return undefined;
    if (refused && classified.refusal.kind === "model") config.recordModelRefusal(coordinator.wireModelId, classified.refusal);
    const evidence = { sessionId, from: coordinator.model, error: report?.error ?? classified.name, ...(wire.status === undefined ? {} : { status: wire.status }) };
    const next = fallbacks.shift();
    if (next === undefined) {
      DebugLog.record({ type: "provider.claude_sdk.host.coordinator_exhausted", payload: { ...evidence, to: config.coordinators[0].model } });
      coordinator = config.coordinators[0];
      fallbacks = config.coordinators.slice(1);
      return "exhausted";
    }
    DebugLog.record({ type: "provider.claude_sdk.host.coordinator_demoted", payload: { ...evidence, to: next.model } });
    coordinator = next;
    return "demoted";
  };

  /** Decides a frame whose turn the engine ended with an error, from the service's answer to the frame's first failed
   *  request (`HostedRequests.frameFailure`). A refusal for the login's spent usage (`reportsSpentUsage`), which the
   *  engine reports as a rate limit with its usage-limit text, belongs to the login and not to the model: every
   *  coordinator model would get it, so the error map marks the login's quota. A request that the service answered
   *  without a record that Flywheel can read is drift of the engine's debug output, never a failure that its SDK error kind classifies. */
  const frameFailed = async (done: Frame, result: CliTurnResult) => {
    const wire = await requests.frameFailure(done.nonce);
    if (closed) return;
    if (reportsSpentUsage(done.report?.text ?? result.text, reports.limitRejection)) frameEnded(done, cliFailure(done.report, result, config.markQuotaExhausted, reports.limitRejection));
    else if (wire === undefined) frameEnded(done, result.status === null ? cliFailure(done.report, result, config.markQuotaExhausted, reports.limitRejection) : requests.drifted("record-incomplete"));
    else {
      const moved = demote(wire, done.report);
      if (moved === "demoted") frameEnded(done, undefined, true);
      else if (moved === "exhausted") frameEnded(done, new LlmStreamError(`The ${CLAUDE_AGENT_SDK_LABEL} agent host found no coordinator model that the service serves`, "transient"));
      else frameEnded(done, wireFailure(wire));
    }
  };

  /** The frame's turn ended, and its outcome is decided. An agent whose task did not start goes into the next frame: at
   *  once after the coordinator moved to its next model (`demoted`), else as a missed delivery. */
  const frameEnded = (done: Frame, failure: Error | undefined, demoted = false) => {
    cutting = false;
    let missed = 0;
    for (const pending of done.batch) {
      if (inFlight.get(pending.agentId) !== pending) continue;
      inFlight.delete(pending.agentId);
      if (failure !== undefined) fail(pending, failure);
      else if (demoted) queued.push(pending);
      else if (++pending.tries >= DELIVERY_TRIES) fail(pending, new LlmStreamError(`The ${CLAUDE_AGENT_SDK_LABEL} agent host did not start the agent`, "transient"));
      else {
        missed += 1;
        queued.push(pending);
      }
    }
    const payload = { sessionId, agents: done.batch.length, missed, ...(failure === undefined ? {} : { failed: failure.name }) };
    if (missed > 0) DebugLog.record({ type: "provider.claude_sdk.host.delivery_missed", payload });
    else DebugLog.record({ type: "provider.claude_sdk.host.frame", payload });
    // A login past its usage limit serves nothing until the reset, so the host ends now with the failure that moves
    // every agent it still holds to the next login, instead of waiting until its last use ends.
    if (failure instanceof QuotaExhaustedError || failure instanceof QuotaCoordinationError) {
      void close("quota", failure);
      return;
    }
    if (conversationStart !== undefined) {
      const target = conversationStart;
      // The cut runs before the next frame, so each frame's dispatcher reads only its own frame. A refused cut keeps
      // its target for the next one.
      cutting = true;
      void Effect.runPromiseExit(launched.rewind(target, done.uuid)).then((exit) => {
        if (Exit.isSuccess(exit) && exit.value.rewound) conversationStart = undefined;
        else DebugLog.record({ type: "provider.claude_sdk.host.rewind_refused", payload: { sessionId, reason: Exit.isSuccess(exit) && !exit.value.rewound ? exit.value.reason : "error" } });
      }).finally(() => {
        cutting = false;
        kick();
      });
      return;
    }
    kick();
  };

  /** Stops the agent's task, or the task that its dispatch would start, and withdraws its waiting dispatch. */
  const stop = (agentId: string, cause: StopCause, reason: Error | undefined) => {
    // The close of the host is the decision that ended every task, and `host.closed` is its one record.
    if (closed) return;
    const named = reason === undefined ? {} : { reason: reason.name };
    listeners.delete(agentId);
    if (running.has(agentId)) {
      if (stopping.has(agentId)) return;
      stopping.add(agentId);
      launched.stopTask(agentId).catch(() => undefined);
      DebugLog.record({ type: "provider.claude_sdk.host.task_stopped", payload: { sessionId, agentId, path: "running", cause, ...named } });
      return;
    }
    const waiting = queued.findIndex((pending) => pending.agentId === agentId);
    const withdrawn = waiting >= 0 ? queued.splice(waiting, 1)[0] : inFlight.get(agentId);
    if (withdrawn === undefined) return;
    const sent = inFlight.delete(agentId);
    if (sent) stopOnStart.add(agentId);
    withdrawn.started.reject(reason ?? new LlmStreamError(`The ${CLAUDE_AGENT_SDK_LABEL} agent host withdrew the agent's dispatch`, "transient"));
    DebugLog.record({ type: "provider.claude_sdk.host.task_stopped", payload: { sessionId, agentId, path: sent ? "stop-on-start" : "queued", cause, ...named } });
  };

  /** Decides a SendMessage call of the dispatcher before it runs (`HostLaunch.refuseDispatch`). A message that the
   *  frame did not ask for would reach its agent as text that Flywheel's history does not hold, so the host denies it:
   *  the agent receives nothing, and the dispatcher's model reads the denial in one more step, which the gate admits.
   *  An agent of the frame that receives no message goes into the next frame. */
  const refuseDispatch = (input: unknown): string | undefined => {
    const fields = asRecord(input);
    const to = fields?.["to"];
    const current = frame;
    const deny = (fault: keyof typeof DENIALS) => {
      if (current !== undefined) gate.denied(current.nonce);
      DebugLog.record({ type: "provider.claude_sdk.host.dispatch_denied", payload: { sessionId, ...(typeof to === "string" ? { agentId: to } : {}), fault } });
      return DENIALS[fault];
    };
    if (current === undefined || typeof to !== "string" || !current.batch.some(({ agentId }) => agentId === to)) return deny("foreign");
    if (current.sent.has(to)) return deny("duplicate");
    if (fields?.["message"] !== DISPATCH_MESSAGE) return deny("changed");
    current.sent.add(to);
    return undefined;
  };

  const readDispatcher = (message: Extract<SDKMessage, { type: "assistant" }>) => {
    const answered = message.message.content.length > 0;
    if (frame === undefined || !answered) {
      // The gate admits only the steps of a frame's turn, and a refused step answers with nothing.
      if (answered) void close("step-gate", stepGateFailure("step-not-asked", AGENT_HOST_PLUGIN));
      return;
    }
    const current = frame;
    if (!current.messages.has(message.message.id)) {
      current.messages.add(message.message.id);
      requests.dispatcherUsage(current.nonce, inputTokens(message.message.usage));
    }
    if (current.messages.size > gate.dispatcherSteps(current.nonce)) void close("step-gate", stepGateFailure("step-not-asked", AGENT_HOST_PLUGIN));
    else watch(current);
  };

  const read = (message: SDKMessage) => {
    const input = classifySdkMessage(message);
    reports.arrived(input);
    // A turn result of the host is the dispatcher's, which says nothing of the reports that the agents' responses owe:
    // the next admission and the close settle an owed report instead.
    const usageStop = input.kind === "rate-limit" ? reports.read(input) : undefined;
    if (usageStop !== undefined) {
      void close("extra-usage", usageStop.error);
      return;
    }
    if (input.kind === "init") {
      cliVersion = input.cliVersion;
      if (refusesSilent() !== undefined) return;
    }
    // Without the plugin, the engine sends every step without asking the gate.
    if (input.kind === "init" && !input.plugins.includes(AGENT_HOST_PLUGIN)) {
      void close("step-gate", stepGateFailure("plugin-not-loaded", AGENT_HOST_PLUGIN));
      return;
    }
    const record = asRecord(message);
    if (message.type === "system") {
      const subtype = String(message.subtype);
      const taskId = record?.["task_id"];
      if (typeof taskId !== "string") return;
      if (subtype === "task_started") {
        running.set(taskId, Promise.withResolvers());
        if (stopOnStart.delete(taskId)) {
          launched.stopTask(taskId).catch(() => undefined);
          return;
        }
        const pending = inFlight.get(taskId);
        if (pending === undefined) return;
        inFlight.delete(taskId);
        served = true;
        pending.started.resolve();
      } else if (subtype === "task_notification") {
        const status = record?.["status"];
        const end: TaskEnd = status === "completed" ? "completed" : status === "stopped" ? "stopped" : "failed";
        running.get(taskId)?.resolve();
        running.delete(taskId);
        stopping.delete(taskId);
        requests.retire(taskId);
        // The task's end is its listener's last news, so the host keeps the listener no longer.
        const listener = listeners.get(taskId);
        listeners.delete(taskId);
        listener?.ended(end);
      }
      return;
    }
    // The engine reports a dispatcher request that failed by a synthetic message with its error kind
    // (`SDKAssistantMessage.error`). No model answered it; the frame's records hold the request itself.
    if (input.kind === "cli-error") {
      if (frame !== undefined) frame.report = input.report;
      return;
    }
    // The usage guard read the report.
    if (input.kind === "rate-limit") return;
    if (message.type === "assistant" && message.parent_tool_use_id === null) {
      readDispatcher(message);
      return;
    }
    if (input.kind !== "turn-result" || frame === undefined || input.result.userMessageUuid !== frame.uuid) return;
    const { result } = input;
    const done = frame;
    frame = undefined;
    clearTimeout(done.watchdog);
    gate.retire(done.nonce);
    frames += 1;
    if (!result.isError) {
      requests.frameEnded(done.nonce);
      frameEnded(done, undefined);
      return;
    }
    // The next frame waits for the decision, which can move the coordinator to another model.
    cutting = true;
    void frameFailed(done, result);
  };

  let closing: Promise<void> | undefined;
  function close(reason: string, error?: Error): Promise<void> {
    closing ??= closeNow(reason, error);
    return closing;
  }

  async function closeNow(reason: string, error: Error = new LlmStreamError(`The ${CLAUDE_AGENT_SDK_LABEL} agent host closed`, "transient")): Promise<void> {
    closed = true;
    gate.close();
    // The open frame ends with the host, so a message that the engine sends while it stops arms no watchdog.
    const open = frame;
    frame = undefined;
    if (open !== undefined) clearTimeout(open.watchdog);
    const waiting = [...queued.splice(0), ...inFlight.values()];
    for (const pending of waiting) fail(pending, error);
    inFlight.clear();
    for (const listener of listeners.values()) listener.ended("stopped", error);
    listeners.clear();
    for (const task of running.values()) task.resolve();
    stopping.clear();
    ended.resolve(error);
    // The requests that no later record took: the host's last agent answered before its last frame ended.
    const unrecordedDispatcherRequests = requests.close(error);
    // A complete response whose usage report the engine still owes is decided before the engine stops: a missing
    // report stops the account as on any other close (bridge rule 14).
    await settleUsage();
    const stopped = await Effect.runPromise(launched.stop());
    toolGate.close();
    Effect.runSync(Queue.end(prompt));
    server.close();
    await launched.close();
    let artifactsKept = false;
    try {
      rmSync(hostSessionFolder(folder), { recursive: true, force: true });
      rmSync(`${hostSessionFolder(folder)}.jsonl`, { force: true });
      transcriptFiles.removeEmptyDirectory(dirname(hostSessionFolder(folder)));
      unlock();
    } catch {
      // Another process holds a file of the folder (Windows EBUSY or EPERM). The session stays locked until this
      // process ends, so that a later sweep removes the folder then.
      artifactsKept = true;
    }
    DebugLog.record({ type: "provider.claude_sdk.host.closed", payload: { sessionId, reason, frames, unrecordedDispatcherRequests, ...(artifactsKept ? { artifactsKept } : {}), ...stopped, ...server.evidence() } });
  }

  return {
    sessionId, folder, toolGate, ended: ended.promise,
    get served() { return served; },
    definition(systemPrompt, model) {
      const name = `fw-${createHash("sha256").update(`${model}\n${systemPrompt}`).digest("hex").slice(0, 16)}`;
      if (!definitions.has(name)) {
        definitions.add(name);
        reloadNeeded = true;
        const tools = config.values.tools.map(({ name: tool }) => `${TOOL_MCP_PREFIX}${tool}`);
        writeFileSync(join(server.pluginPath, "agents", `${name}.md`), `---\nname: ${name}\ndescription: A Flywheel agent\ntools: ${JSON.stringify(tools)}\nmodel: ${model}\n---\n${systemPrompt}`);
      }
      return `${AGENT_HOST_PLUGIN}:${name}`;
    },
    async admit(agentId, values, sink) {
      const usageStop = await settleUsage();
      if (usageStop !== undefined) throw usageStop.error;
      const silent = refusesSilent();
      if (silent !== undefined) throw silent;
      // The stop chunk ends a complete response, whose usage report the engine then owes.
      return gate.admit(agentId, values, { item: (item) => { if (item.kind === "stop") reports.served(); sink.item(item); }, done: () => { sink.done(); } });
    },
    dispatch(agentId, listener) {
      const pending: Pending = { agentId, listener, started: Promise.withResolvers(), tries: 0 };
      if (closed) pending.started.reject(new LlmStreamError(`The ${CLAUDE_AGENT_SDK_LABEL} agent host closed`, "transient"));
      else {
        listeners.set(agentId, listener);
        queued.push(pending);
        kick();
      }
      return pending.started.promise;
    },
    takeHiddenRequests: (agentId) => requests.takeHidden(agentId),
    released: (agentId) => { requests.released(agentId); },
    requestFailure: (agentId) => requests.failure(agentId),
    settled: async (agentId) => { await running.get(agentId)?.promise; },
    stopTask: stop,
    close: (reason, error) => close(reason, error),
  };
}

/** The input tokens that a dispatcher response states: its uncached input and its cache reads and writes. */
function inputTokens(usage: unknown): number {
  const counted = asRecord(usage);
  const count = (field: string) => {
    const value = counted?.[field];
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
  };
  return count("input_tokens") + count("cache_read_input_tokens") + count("cache_creation_input_tokens");
}
