import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { Cause, Effect, Queue } from "effect";
import { awaitWithAbortSignal } from "../../../../infra/abort.js";
import type { ModelRefusal } from "../../../../infra/auth/provider-model-catalog-store.js";
import { DebugLog } from "../../../../infra/debug-log.js";
import { isGitRepo } from "../../../../infra/env-detection.js";
import type { AccessProviderCandidateAttribution } from "../../../../infra/llm/access-provider.js";
import type { AnthropicOperations } from "../../../agent-runtime/llm/anthropic.js";
import { LlmStreamError, ProviderRequestValidationError } from "../../../agent-runtime/llm/errors.js";
import { engineModelId } from "../../../agent-runtime/llm/claude-reminders.js";
import type { ProviderDemand, TransportContextFrame } from "../../../agent-runtime/llm/types.js";
import { bridgeClosedError } from "../bridge-requests.js";
import { cliView, type CliView } from "../cli-view.js";
import { onceClaim, sessionEngineDemand } from "../engine-demand.js";
import { engineBlockLocation } from "../engine-additions.js";
import type { ExtraUsage, ExtraUsageStop } from "../extra-usage-guard.js";
import { registerLiveBridge } from "../live-bridges.js";
import { loginFailure, type RequestOutcome } from "../login-observations.js";
import type { UsageWindows } from "../account-usage.js";
import { CLAUDE_AGENT_SDK_LABEL } from "../names.js";
import { engineValues } from "../query-engine.js";
import type { HostLaunch, LaunchedHost } from "../query-launcher.js";
import { planRequest, type CliCopy, type HandlerDelivery, type QueryState } from "../request-plan.js";
import { queueIterable } from "../queue-iterable.js";
import type { QuotaMark } from "../sdk-events.js";
import type { SilentVersions } from "../stderr-signals.js";
import { agentFilePath, agentRows, removeAgentFile, writeAgentFile, type AgentRows } from "./agent-file.js";
import { hostedStreamEvents, type StepEvent } from "./agent-stream.js";
import { hostedTransportContext, hostedView, type HeldRequestContext, type HeldRewrite } from "./engine-text.js";
import type { HostStepItem } from "./host-gate.js";
import { coordinatorCandidates, hostKey, hostValues, type HostLease, type HostPlace, type HostRegistry } from "./host-registry.js";
import { openAgentHost, type AgentHost, type StopCause, type TaskEnd } from "./host.js";
import type { SharedTree } from "../../../agent-runtime/shared-tree.js";

/** What a hosted agent's parked engine takes through its handlers: every result whose rewrite is fixed, and the
 *  request's runtime notices on the last result. */
const hostedDelivery = (input: HostedRequestInput): HandlerDelivery => ({ results: "successes-and-errors", runtimeNotices: input.runtimeNotices ?? [] });

/** What one hosted agent's client fixes: where its hosts run, and the login's guards and records. */
export interface HostedAgentConfig {
  readonly registry: HostRegistry;
  readonly launchHost: (launch: HostLaunch) => LaunchedHost;
  readonly configDir: string;
  /** The shared state of the chat tree that the agent belongs to. Its hosted descendants share hosts, and each host
   *  holds the tree while it lives. */
  readonly tree: SharedTree;
  /** The account key (`accessProviderAccountKey`) of the login that the client serves, which a host that it opens
   *  names as the tree's login, so the tree's later requests prefer it while it can serve. */
  readonly login: string;
  readonly projectRoot: string;
  readonly wireModelId: string;
  readonly contextLimit: number;
  /** The login's models that a host's coordinator may run on (`AccessProviderBuild.accountOfferings`). */
  readonly lineup: () => readonly AccessProviderCandidateAttribution[];
  readonly recordModelRefusal: (wireModelId: string, refusal: ModelRefusal) => void;
  readonly markQuotaExhausted: QuotaMark;
  /** The engine versions whose debug output Flywheel cannot read (`AgentHostConfig.silentVersions`). */
  readonly silentVersions: SilentVersions;
  readonly extraUsage: ExtraUsage;
  readonly reportsExtraUsage: () => boolean;
  readonly accountEmail: () => string | undefined;
  /** The shell that the engine names, read when an agent file is written (`engineShell`). */
  readonly engineShell: () => string | undefined;
  readonly onExtraUsageStop: (stop: ExtraUsageStop) => void;
  readonly recordUsage: (windows: UsageWindows) => void;
  readonly recordOutcome: (outcome: RequestOutcome) => void;
  /** The agent's own engine, for a request that no host can serve exactly (`hostable`). */
  readonly ownEngine: () => Promise<AnthropicOperations>;
  /** The engine demand of the session whose client this is (`ProviderSessionLifetime.demand`), which holds the hosts
   *  that the session's anticipations claim. */
  readonly demand?: ProviderDemand;
  /** The dispatcher deadline of each host that the bridge opens (`AgentHostConfig.dispatcherStepDeadlineMs`). */
  readonly dispatcherStepDeadlineMs?: number;
}

/** The input of one request beyond its prepared body: its request-only text (`StreamOptions.requestContext`) and the
 *  text of its trailing runtime notices (`trailingRuntimeNotices`). The forecast and the served request read the same
 *  value, so both make the same plan. */
interface HostedRequestInput {
  readonly requestContext?: string;
  readonly runtimeNotices?: readonly string[];
}

/** One hosted agent: its requests, and the forecast of whether its next request starts or resumes it. */
export interface HostedAgent {
  /** Whether the request whose view is `view`, which a host serves (`PreparedAnthropicRequest.historyTarget`), is a
   *  dispatch, which the hosted request entries read from the request that the client receives
   *  (`createHostedAgentEntries`). A request extends the agent's running turn only when the agent is parked on the host of the request's values and
   *  the bridge's plan of the request delivers the parked calls' results (`planRequest`), with the request's runtime
   *  notices folded into the last result when its input is only those notices: the plan that the bridge makes of the
   *  same request when it serves it. Every other hosted request is a dispatch. */
  dispatches(view: CliView, input: HostedRequestInput): boolean;
  readonly operations: AnthropicOperations;
  /** Stops the agent for `cause`, removes its file, and ends the bridge's use of its host: `abort` when a person's or
   *  a parent's stop ended the agent's session, else `lifetime-end`. Resolves when the use ended, which waits for the
   *  host's close when it was the host's last use (`HostLease.release`). */
  close(cause: Extract<StopCause, "abort" | "lifetime-end">): Promise<void>;
}

type Phase =
  /** A step streams. */
  | { readonly kind: "running" }
  /** The engine waits in the MCP handlers of these tool uses. */
  | { readonly kind: "parked"; readonly toolUseIds: readonly string[] }
  /** The agent answered; its task ends or ended. */
  | { readonly kind: "idle" }
  /** The engine's copy is not Flywheel's, or the agent ended: the next request starts a new agent. */
  | { readonly kind: "gone" };

interface Agent {
  readonly id: string;
  readonly host: AgentHost;
  /** The key of the agent's host. */
  readonly key: string;
  readonly rows: AgentRows;
  phase: Phase;
  copy: CliCopy | undefined;
  /** The request-only text that the agent's dispatch gave the engine, which its later steps do not repeat. */
  readonly requestContext: HeldRequestContext | undefined;
  /** The results that the engine rewrote since the agent's dispatch, which every later step's record states. */
  readonly rewrites: HeldRewrite[];
  /** The open request's step, which the first end of the request decides. `end` ends the request with `error` and
   *  stops the agent's task for `cause`; `ended` ends the request with `error` after the engine or the close of the host
   *  ended the task, so it stops nothing. */
  step: { end(error: Error, cause: StopCause): void; ended(error: Error): void } | undefined;
}

/** The engine's own form of an agent id: `a` and 16 hexadecimal digits. */
function newAgentId(): string {
  return `a${randomBytes(8).toString("hex")}`;
}

/**
 * Builds one hosted agent: the Flywheel conversation of one agent id at a time in a shared agent host
 * (agent-host/host.ts). Each request is planned as the chat bridge plans it (`planRequest`). A request that adds
 * exactly the results of the parked tool calls extends the agent's turn: the bridge hands the results to the host's
 * tool gate, and the gate admits the agent's next step. So does a request whose input after those results is only
 * runtime notices, such as a child's completion: they ride on the last result, so a parent that waits on its children
 * reads each completion in its open tool call. Every other request is a dispatch: the bridge writes the
 * agent file with the whole conversation and the host's dispatcher starts the agent from it, under the same id when
 * the agent answered and its task ended, else under a new id after `stopTask` ended the old one. The effort is part of
 * the agent's identity, so a changed effort, also of a parked agent, starts it again under a new id. A request whose
 * launch values differ from the host's moves the agent to the host of its new values. The agent runs on the bridge's
 * model on any host, because its definition states that model; a model change replaces the bridge, and the new
 * bridge's first request dispatches the agent again, on the same host when the host's values did not change. The bridge holds its host's
 * lease for its whole life, so a host closes when the last runner that uses it ends (`HostLease`). A request that the
 * bridge anticipates (`AnthropicOperations.anticipate`) claims the host of its values before it comes, so a session
 * that a client shows holds the host that its roles run on, and the request's dispatch finds the host started. The
 * claim of a session's anticipation shares the session's one lease of that host (`sessionEngineDemand`); any other
 * claim holds a lease of its own until its owner releases it. The module turned off ends the bridge's lease once its
 * open request settled (`releaseLiveBridges`), so a host closes when its last running request settled, never before.
 */
export function createHostedAgent(config: HostedAgentConfig): HostedAgent {
  let held: { readonly key: string; readonly lease: HostLease } | undefined;
  /** The ends of the bridge's uses of hosts, which `close` waits for, also those of uses that a move or a failure
   *  ended. */
  let releasing: Promise<void> = Promise.resolve();
  let agent: Agent | undefined;
  let closed = false;
  let own: Promise<AnthropicOperations> | undefined;
  /** The model that the agent's definition states, in the engine's spelling, so the engine's model line for the
   *  agent and the model reminder in its history name the same model. */
  const definitionModel = engineModelId(config.wireModelId, config.contextLimit);

  /** Ends the bridge's use of its host. The registry owns the close that a last use starts, so a move to another host
   *  waits for nothing, and `close` waits for every such close. */
  const release = (): Promise<void> => {
    const ending = held;
    held = undefined;
    if (ending === undefined) return releasing;
    const ended = ending.lease.release();
    releasing = Promise.all([releasing, ended]).then(() => undefined);
    return releasing;
  };

  /** The bridge's requests to its host whose transport no consumer finished yet. */
  let open = 0;
  /** The module is off, so the bridge ends its lease whenever no request is open. A request admitted before the module
   *  turned off can reach `createStream` after it, and lease a host then, which its settle ends. */
  let moduleOff = false;
  const unregister = registerLiveBridge(() => {
    moduleOff = true;
    if (open === 0) void release();
  }, () => { moduleOff = false; });

  /** Ends the agent's task for `cause` and removes its file. An agent that answered ended its task with its answer, so
   *  only an agent whose step streams or that is parked has a task to stop, and the host's `task_stopped` record is the
   *  one record of that stop. An agent whose session ended at a tool call, such as its handoff, is parked in that
   *  call's handler when its lifetime ends (`lifetime-end`): Flywheel delivers no result for the call, and the stop
   *  is no failure. */
  const endAgent = (current: Agent | undefined, cause: Extract<StopCause, "abort" | "lifetime-end" | "host-ended" | "moved-host" | "restarted" | "own-engine">) => {
    if (current === undefined) return;
    const { phase } = current;
    current.phase = { kind: "gone" };
    // An open step's end stops the agent's task itself.
    if (current.step !== undefined) current.step.end(new LlmStreamError(`The ${CLAUDE_AGENT_SDK_LABEL} agent host ended the agent`, "transient"), cause);
    else if (phase.kind === "parked") current.host.stopTask(current.id, cause);
    removeAgentFile(current.host.folder, current.id);
    if (agent === current) agent = undefined;
  };

  /** Opens the host of `place` for an agent in `agentCwd`. The host runs in the tree root's directory, whose git
   *  status the engine states, unless the agent's directory has another git status (`HostPlace.gitRepository`). */
  const openHost = (place: HostPlace, agentCwd: string) => {
    const cwd = realpathSync(isGitRepo(config.projectRoot) === place.gitRepository ? config.projectRoot : agentCwd);
    const host: AgentHost = openAgentHost({
      launchHost: config.launchHost, configDir: config.configDir, cwd, values: place.values, markQuotaExhausted: config.markQuotaExhausted,
      coordinators: coordinatorCandidates(config.lineup(), place.values, { wireModelId: config.wireModelId, model: definitionModel }), recordModelRefusal: config.recordModelRefusal,
      silentVersions: config.silentVersions,
      ...(config.dispatcherStepDeadlineMs === undefined ? {} : { dispatcherStepDeadlineMs: config.dispatcherStepDeadlineMs }),
      extraUsage: config.extraUsage, reportsExtraUsage: config.reportsExtraUsage(), onExtraUsageStop: config.onExtraUsageStop, recordUsage: config.recordUsage,
    });
    void host.ended.then(config.tree.hold(config.login));
    return host;
  };

  /** Leases the host of `place`. A host that ends drops the lease and its agent, so the next request opens a new host
   *  and starts the agent again there. */
  const leaseHost = (key: string, place: HostPlace, agentCwd: string) => {
    const leased = { key, lease: config.registry.lease(place, () => openHost(place, agentCwd)) };
    const { host } = leased.lease;
    void host.ended.then(() => {
      if (agent?.host === host) agent = undefined;
      if (held === leased) void release();
    });
    return leased;
  };

  const queryState = (current: Agent | undefined): QueryState => {
    if (current === undefined || current.copy === undefined || current.phase.kind === "gone" || current.phase.kind === "running") return { kind: "released" };
    return current.phase.kind === "parked" ? { kind: "parked", copy: current.copy, toolUseIds: current.phase.toolUseIds } : { kind: "idle", copy: current.copy };
  };

  const recordFailure = (error: Error) => {
    const failure = loginFailure(error, false);
    if (failure !== undefined) config.recordOutcome(failure);
  };

  // The git status of an agent's directory, read once per directory for the bridge's life: placement runs at every
  // request, and the read walks the file system upward.
  const gitStatus = new Map<string, boolean>();
  const gitRepository = (cwd: string) => {
    const known = gitStatus.get(cwd) ?? isGitRepo(cwd);
    gitStatus.set(cwd, known);
    return known;
  };
  /** Where the request whose view is `view` runs: the host's place and key, the agent's directory, and the step's
   *  effort. Every value of the place must be the same for every agent of the tree: a value that differs starts
   *  another engine process, so a new difference must be an entry of `HOST_SPLIT_EXCEPTIONS` with its reason. The
   *  agent's directory is no part of the place; its meta file states it (`AgentFileInput.cwd`). Its git status is,
   *  as an accepted split (`HostPlace.gitRepository`). */
  const placement = (view: CliView) => {
    const values = engineValues(view.identity, config.wireModelId, config.contextLimit);
    const { cwd } = view.identity;
    const place: HostPlace = {
      configDir: config.configDir, extraUsage: config.extraUsage, treeRootSessionId: config.tree.treeRootSessionId, gitRepository: gitRepository(cwd), values: hostValues(values),
    };
    return { place, key: hostKey(place), cwd, stepEffort: values.effort };
  };

  const stream = async (view: CliView, signal: AbortSignal, input: HostedRequestInput, onProgress: () => void): Promise<AsyncIterable<Anthropic.RawMessageStreamEvent | TransportContextFrame>> => {
    const { place, key, cwd, stepEffort } = placement(view);
    const { requestContext } = input;
    if (held?.key !== key) {
      void release();
      held = leaseHost(key, place, cwd);
    }
    const host = held.lease.host;
    // An agent of another host moves here; a host that closed while the bridge held no lease took its agent with it.
    const moved = agent !== undefined && agent.host !== host;
    if (moved) endAgent(agent, agent?.key === key ? "host-ended" : "moved-host");
    const delivery = hostedView(view, agent?.requestContext);
    const plan = planRequest(delivery, queryState(agent), hostedDelivery(input));
    if (plan.kind === "refuse") throw new ProviderRequestValidationError(CLAUDE_AGENT_SDK_LABEL, plan.issue);
    // A dispatch writes the whole conversation to the agent file, so request-only text that the engine holds from an
    // earlier dispatch moves to this dispatch's message.
    const hosted = plan.kind === "deliver" ? delivery : hostedView(view);
    const effort = stepEffort === undefined ? {} : { effort: stepEffort };
    const events = Effect.runSync(Queue.unbounded<StepEvent, Error | Cause.Done>());
    const sink = {
      item: (item: HostStepItem) => { Queue.offerUnsafe(events, { kind: "item", item }); },
      done: () => { Queue.offerUnsafe(events, { kind: "done" }); },
    };
    /** Opens the request's step on `target`. Its first end, whatever ends it (an abort, the end of the agent's task
     *  or host, or a failed dispatch), withdraws the admission, stops the agent's task when Flywheel decided the end,
     *  and fails the request; a later end does nothing. Events that the step already streamed come before the
     *  failure. */
    const openStep = async (target: Agent) => {
      const admission = await host.admit(target.id, effort, sink);
      if (signal.aborted) {
        admission.close();
        throw signal.reason;
      }
      const finish = (error: Error, cause: StopCause | undefined) => {
        if (target.step !== step) return;
        target.step = undefined;
        admission.close();
        target.phase = { kind: "gone" };
        if (cause !== undefined) host.stopTask(target.id, cause, error);
        Queue.failCauseUnsafe(events, Cause.fail(error));
      };
      const step: NonNullable<Agent["step"]> = { end: finish, ended: (error) => { finish(error, undefined); } };
      target.step = step;
      target.phase = { kind: "running" };
      // The adapter aborts the signal when it leaves the request, before or after the response's end, so the abort
      // also tells the host that the step's transport was consumed.
      signal.addEventListener("abort", () => {
        step.end(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)), "abort");
        host.released(target.id);
      }, { once: true });
      return { admission, step };
    };

    const dispatched = hosted.dispatches.at(-1) === hosted.messages.length - 1;
    let current: Agent;
    let opened: Awaited<ReturnType<typeof openStep>>;
    let from = 0;
    if (!dispatched) {
      // The request entries planned this request as a delivery (`dispatches`), so it holds no dispatch wrapper.
      if (agent === undefined || agent.phase.kind === "gone") {
        // The agent's host or task ended after that plan, while the request waited on its records. The request that
        // the provider walk prepares again is a dispatch; the bridge keeps its lease, and a host that really ended
        // released it through its end.
        throw new LlmStreamError(`The ${CLAUDE_AGENT_SDK_LABEL} agent host ended the agent before its tool results reached it`, "transient");
      }
      // The plan reads the same request for the same live agent, so any other plan is a defect of the bridge.
      if (plan.kind !== "deliver") throw new ProviderRequestValidationError(CLAUDE_AGENT_SDK_LABEL, `a request without a dispatch wrapper plans ${plan.kind === "start" ? plan.trigger.kind : plan.kind}, not a delivery`);
      current = agent;
      opened = await openStep(current);
      from = current.rows.read().length;
      for (const { toolUseId, rewrite } of plan.results) if (rewrite !== undefined) current.rewrites.push({ at: delivery.messages.length - 1, toolUseId, rewrite });
      host.toolGate.deliver(plan.results);
    } else {
      const resumed = plan.kind === "push" && agent?.phase.kind === "idle" ? agent : undefined;
      if (resumed === undefined) endAgent(agent, "restarted");
      else await awaitWithAbortSignal(host.settled(resumed.id), signal);
      const id = resumed?.id ?? newAgentId();
      const agentType = host.definition(hosted.definitionPrompt, definitionModel);
      const accountEmail = config.accountEmail();
      const shell = config.engineShell();
      const offset = writeAgentFile(host.folder, {
        agentId: id, agentType, model: config.wireModelId, cwd, view: hosted, ...(accountEmail === undefined ? {} : { accountEmail }), ...(shell === undefined ? {} : { shell }),
      });
      current = {
        id, host, key, rows: agentRows(agentFilePath(host.folder, id), offset), phase: { kind: "running" }, copy: undefined, rewrites: [], step: undefined,
        requestContext: hosted.endsWithRequestContext && requestContext !== undefined ? { text: requestContext, at: hosted.messages.length - 1 } : undefined,
      };
      agent = current;
      DebugLog.record({ type: "provider.claude_sdk.host.agent_dispatched", payload: {
        sessionId: host.sessionId, agentId: id, resumed: resumed !== undefined, plan: plan.kind, moved,
        ...(plan.kind === "start" ? {
          trigger: plan.trigger.kind,
          ...(plan.trigger.kind === "identity" ? { field: plan.trigger.field } : {}),
          ...(plan.trigger.kind === "undeliverable-result" ? { result: plan.trigger.result } : {}),
          ...(plan.trigger.kind === "notice-carrier" ? { reason: plan.trigger.reason } : {}),
        } : {}),
      } });
      opened = await openStep(current);
      const started = current;
      const dispatch = host.dispatch(id, {
        ended: (taskEnd: TaskEnd, error?: Error) => {
          if (taskEnd === "completed") return;
          started.step?.ended(error ?? new LlmStreamError(`The ${CLAUDE_AGENT_SDK_LABEL} agent host's task of the agent ${taskEnd === "stopped" ? "stopped" : "failed"}`, "transient"));
          started.phase = { kind: "gone" };
        },
        refused: () => { started.phase = { kind: "gone" }; },
      });
      try {
        await awaitWithAbortSignal(dispatch, signal);
      } catch (error) {
        // The abort already stopped the agent's task; the host lost nothing.
        if (signal.aborted) throw error;
        const failure = error instanceof Error ? error : new Error(String(error));
        opened.step.end(failure, "dispatch-failed");
        recordFailure(failure);
        throw error;
      }
    }
    const { step } = opened;
    // History never holds request-only text, so the copy that later requests are compared with leaves out what the
    // engine holds.
    const copied = hostedView(view, current.requestContext).messages;
    const answered = hostedStreamEvents(queueIterable(events), current.rows, from, config.wireModelId, () => host.requestFailure(current.id), (answer) => {
      if (current.step === step) current.step = undefined;
      opened.admission.close();
      current.copy = { identity: hosted.identity, messages: [...copied, answer.message] };
      const toolUseIds = answer.message.content.flatMap((block) => block.type === "tool_use" ? [block.id] : []);
      if (current.phase.kind === "running") current.phase = answer.stopReason === "tool_use" ? { kind: "parked", toolUseIds } : { kind: "idle" };
      config.recordOutcome("served");
    }, onProgress);
    // The record takes the dispatcher's requests that the host holds now, and waits for none.
    const transportRecord = (): TransportContextFrame => ({
      type: "transport_context",
      context: hostedTransportContext(hosted, dispatched, config.accountEmail() !== undefined, host.takeHiddenRequests(current.id), current.rewrites),
    });
    return withRecord(answered, transportRecord, (error) => {
      // An abort ends only this request: the step's end stopped the agent's task, and the host serves on.
      if (signal.aborted) return;
      if (current.phase.kind === "running") current.phase = { kind: "gone" };
      step.end(error, "request-failed");
      recordFailure(error);
      DebugLog.record({ type: "provider.claude_sdk.host.agent_failed", payload: { sessionId: host.sessionId, agentId: current.id, error: error.name } });
    });
  };

  const operations: AnthropicOperations = {
    anticipate: async (params, { sharedHost, origins }) => {
      if (closed || !sharedHost) return undefined;
      // An anticipation never fails: a request that cannot be read or placed, or whose host cannot open, such as one
      // in an agent directory that is gone, fails the same way when it streams, which reports it.
      try {
        const { place, key, cwd } = placement(cliView(params, origins, config.projectRoot));
        const lease = () => config.registry.lease(place, () => openHost(place, cwd));
        if (config.demand !== undefined) return sessionEngineDemand(config.demand).claimHost(key, lease);
        const leased = lease();
        return onceClaim(leased.release);
      } catch {
        return undefined;
      }
    },
    createStream: async (params, options) => {
      const { signal } = options;
      signal.throwIfAborted();
      if (closed) throw bridgeClosedError();
      // A request that no host can serve goes to the agent's own engine as it is, as on every route that is not a
      // host. Its forecast added none of the host's engine text, and its history leaves out the host's framing.
      if (!options.sharedHost) {
        endAgent(agent, "own-engine");
        void release();
        own ??= config.ownEngine();
        return (await own).createStream(params, options);
      }
      // The adapter aborts the controller after every request: before the response's end it stops the agent's task,
      // after it it is only a release.
      const controller = new AbortController();
      const requestSignal = AbortSignal.any([signal, controller.signal]);
      open += 1;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        open -= 1;
        if (open === 0 && moduleOff) void release();
      };
      requestSignal.addEventListener("abort", settle, { once: true });
      try {
        const data = await stream(cliView(params, options.origins, config.projectRoot), requestSignal, options, () => { options.onProgress?.(); });
        return { data: Object.assign(data, { controller }), response: new Response(null) };
      } catch (error) {
        settle();
        throw error;
      }
    },
    isBadRequestError: (error) => error instanceof Anthropic.BadRequestError,
    preparedBlock: engineBlockLocation,
  };

  return {
    operations,
    dispatches(view, input) {
      const current = agent;
      if (current === undefined || held?.key !== placement(view).key || current.host !== held.lease.host) return true;
      return planRequest(hostedView(view, current.requestContext), queryState(current), hostedDelivery(input)).kind !== "deliver";
    },
    async close(cause) {
      if (closed) return;
      closed = true;
      unregister();
      endAgent(agent, cause);
      await release();
    },
  };
}

/** `events`, then the request's transport record (ARCH-CONTEXT-008), which also follows a failure before it is thrown.
 *  `onError` hears the error that ended the events.
 *  @yields {A | TransportContextFrame} Each event of `events`, then the record. */
async function* withRecord<A>(events: AsyncGenerator<A>, record: () => TransportContextFrame, onError: (error: Error) => void): AsyncGenerator<A | TransportContextFrame> {
  try {
    yield* events;
  } catch (error) {
    onError(error instanceof Error ? error : new Error(String(error)));
    yield record();
    throw error;
  }
  yield record();
}
