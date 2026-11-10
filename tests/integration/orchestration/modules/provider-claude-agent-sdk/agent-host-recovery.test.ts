/**
 * The shared agent host on a fake host when a request, the dispatcher, the engine, or the host fails or stalls. Each
 * case drives an agent loop as `agent-host.test.ts` does.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { LaunchedHost } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/query-launcher.js";
import { DISPATCH_TEXT } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/engine-text.js";
import { createHostRegistry, type HostRegistry } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/host-registry.js";
import { createHostLauncher } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/query-launcher.js";
import { createLoginObservations, type RequestOutcome } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/login-observations.js";
import type { ModelRefusal } from "../../../../../src/infra/auth/provider-model-catalog-store.js";
import { fakeAvailability } from "../../../../unit/orchestration/agent-runtime/llm/_provider-chain-harness.js";
import { CONTINUATION_MESSAGES } from "../../../../../src/orchestration/agent-runtime/continuation-messages.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { agentLoop, dispatchedIds, hiddenRequests, hostScript, isDispatcher, lastUserTexts, LOOKUP, lookupThenAnswer, registryProxy, SYSTEM, textOf, TREE, wireMessages } from "./_agent-host.js";
import type { NotificationEpisodeInput } from "../../../../../src/infra/notification-episode.js";
import { captureDiagnostics, onFakeHost, removeEngineProbes, streamedText, streamedToolCalls, until } from "./_claude-sdk-client.js";
import type { FakeReply, RecordedRequest } from "./_fake-host.js";

const temporary = temporaryDirectories();
removeEngineProbes();
const diagnostics = captureDiagnostics();
/** The launch records of the shared hosts' engines. */
const hostLaunches = () => diagnostics.payloads("provider.claude_sdk.engine.launched").filter(({ role }) => role === "host");

/** A dispatcher deadline that a stalled response passes long before the engine's own timeouts end it. */
const DISPATCHER_STEP_DEADLINE_MS = 3_000;

let registry: HostRegistry;
afterEach(async () => { await registry.drain(); });
const agentHosts = registryProxy(() => registry);

describe("the shared agent host's recovery", () => {
  test("a failed request ends only its agent, and the next request starts it again under a new id with its history", async () => {
    registry = createHostRegistry();
    let failed = false;
    await onFakeHost(temporary, hostScript((request) => {
      if (!failed && lastUserTexts(request).some((text) => text.startsWith("Fail"))) {
        failed = true;
        return { blocks: [], status: 529 };
      }
      return lookupThenAnswer(request);
    }), async ({ host, stage, projectRoot }) => {
      const failing = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Fail first.");
      const steady = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Work.");
      const [failure, work] = await Promise.all([failing.request(), steady.request()]);
      expect(failure.error).toMatchObject({ failure: { _tag: "OverloadedFailure" } });
      expect(work.error).toBeUndefined();
      const earlier = new Set(dispatchedIds(host.requests));
      const retried = await failing.request();
      expect(retried.error).toBeUndefined();
      expect(streamedToolCalls(retried)[0]?.name).toBe("lookup");
      // The retry is a new agent: its dispatch names an id that no earlier frame named.
      const retriedIds = dispatchedIds(host.requests).filter((id) => !earlier.has(id));
      expect(retriedIds).toHaveLength(1);
    }, { seams: { agentHosts } });
  }, 120_000);

  test("an engine crash fails the request that streams, and the next request starts the agent on a new host from its history", async () => {
    registry = createHostRegistry();
    const launched: LaunchedHost[] = [];
    let hung = false;
    await onFakeHost(temporary, hostScript((request) => {
      if (!hung) {
        hung = true;
        return { blocks: [{ text: "partial" }], open: true };
      }
      return lookupThenAnswer(request);
    }), async ({ stage, projectRoot }) => {
      const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Find the value.");
      const crashed = await agent.request(undefined, (event) => { if (event.kind === "text_delta") void launched[0]?.process.terminate(); });
      expect(crashed.error).toBeDefined();
      const retried = await agent.request();
      expect(retried.error).toBeUndefined();
      expect(streamedToolCalls(retried)[0]?.name).toBe("lookup");
      expect(launched).toHaveLength(2);
    }, { seams: { agentHosts, createHostLauncher: (config) => { const launch = createHostLauncher(config); return (input) => { const host = launch(input); launched.push(host); return host; }; } } });
  }, 120_000);

  test("a stalled agent's continuation dispatches once, the engine's wrapper follows the request-only text, and its later tool rounds extend its turn", async () => {
    registry = createHostRegistry();
    let stalled = false;
    const lookups = (request: RecordedRequest): FakeReply => {
      const results = wireMessages(request).flatMap((message) => typeof message.content === "string" ? [] : message.content.filter((block) => block.type === "tool_result")).length;
      return results < 2 ? { blocks: [{ thinking: "I need a value." }, { tool: "lookup", input: { key: `k${results}` } }] } : { blocks: [{ thinking: "Done." }, { text: "Both values are ready." }] };
    };
    await onFakeHost(temporary, hostScript((request) => {
      if (stalled) return lookups(request);
      stalled = true;
      return { blocks: [], status: 529 };
    }), async ({ host, stage, projectRoot }) => {
      const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Find the value.");
      expect((await agent.request()).error).toBeDefined();
      agent.requestContext = CONTINUATION_MESSAGES.stream_stalled;
      const continued = await agent.request();
      expect(continued.error).toBeUndefined();
      expect(streamedToolCalls(continued)[0]?.name).toBe("lookup");
      // The failed request's wrapper is the one wrapper of the continuation, which the engine sends after the text.
      expect(agent.history.filter((message) => textOf(message) === DISPATCH_TEXT)).toHaveLength(1);
      const sent = host.requests.filter((request) => !isDispatcher(request)).at(-1);
      if (sent === undefined) throw new Error("no agent request");
      // The engine ends the text before its wrapper with a line break.
      expect(lastUserTexts(sent).slice(-2).map((text) => text.trimEnd())).toEqual([CONTINUATION_MESSAGES.stream_stalled, DISPATCH_TEXT]);
      const coordinator = continued.events.flatMap((event) => event.kind === "transport_context" ? event.context.additions.filter(({ kind }) => kind === "coordinator") : []);
      expect(coordinator).toEqual([{ part: "message", kind: "coordinator", at: 0, value: "after-request-context" }]);

      // Each later request of the logical turn still ends with the same request-only text, and each one delivers its
      // results to the parked agent, whose engine holds the text once at its dispatch.
      const dispatches = diagnostics.payloads("provider.claude_sdk.host.agent_dispatched").length;
      const stops = diagnostics.payloads("provider.claude_sdk.host.task_stopped").length;
      const dispatcherRequests = host.requests.filter(isDispatcher).length;
      agent.result(streamedToolCalls(continued)[0]?.id ?? "", "VALUE ONE");
      const second = await agent.request();
      expect(second.error).toBeUndefined();
      agent.result(streamedToolCalls(second)[0]?.id ?? "", "VALUE TWO");
      const third = await agent.request();
      expect(third.error).toBeUndefined();
      expect(streamedText(third)).toBe("Both values are ready.");
      expect(diagnostics.payloads("provider.claude_sdk.host.agent_dispatched")).toHaveLength(dispatches);
      expect(diagnostics.payloads("provider.claude_sdk.host.task_stopped")).toHaveLength(stops);
      expect(host.requests.filter(isDispatcher)).toHaveLength(dispatcherRequests);
      const delivered = host.requests.filter((request) => !isDispatcher(request)).slice(-2);
      expect(delivered).toHaveLength(2);
      for (const request of delivered) {
        expect(lastUserTexts(request)).not.toContain(DISPATCH_TEXT);
        expect(JSON.stringify(wireMessages(request)).split(JSON.stringify(CONTINUATION_MESSAGES.stream_stalled).slice(1, -1))).toHaveLength(2);
      }
      for (const result of [second, third]) {
        const held = result.events.flatMap((event) => event.kind === "transport_context" ? event.context.additions.filter(({ kind }) => kind === "request-context") : []);
        expect(held).toEqual([{ part: "message", kind: "request-context", at: 0, value: "held-from-dispatch" }]);
      }
    }, { seams: { agentHosts } });
  }, 120_000);

  test("a host that ends after a request planned a delivery fails that attempt as transient, and the request prepared again dispatches on a new host", async () => {
    registry = createHostRegistry();
    let launches = 0;
    let leases = 0;
    const counted: HostRegistry = {
      lease: (...input) => {
        const lease = registry.lease(...input);
        leases += 1;
        let released = false;
        return { host: lease.host, opened: lease.opened, release: () => { if (!released) { released = true; leases -= 1; } return lease.release(); } };
      },
      drain: (...input) => registry.drain(...input),
    };
    await onFakeHost(temporary, hostScript(lookupThenAnswer), async ({ stage, projectRoot }) => {
      const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Find the value.");
      const [call] = streamedToolCalls(await agent.request());
      agent.result(call?.id ?? "", "VALUE");
      agent.beforeStream = () => registry.drain();
      const lost = await agent.request();
      expect(lost.error).toMatchObject({ failure: { _tag: "TransientNetworkFailure" } });
      expect(leases).toBe(1);
      agent.beforeStream = undefined;
      const retried = await agent.request();
      expect(retried.error).toBeUndefined();
      expect(streamedText(retried)).toBe("The value is ready.");
      expect(launches).toBe(2);
      expect(agent.history.filter((message) => textOf(message) === DISPATCH_TEXT)).toHaveLength(2);
      expect(diagnostics.payloads("provider.claude_sdk.host.agent_dispatched").map(({ resumed }) => resumed)).toEqual([false, false]);
      expect(leases).toBe(1);
    }, { seams: { agentHosts: counted, createHostLauncher: (config) => { const launch = createHostLauncher(config); return (input) => { launches += 1; return launch(input); }; } } });
  }, 120_000);

  test.each([
    ["partial bytes", { blocks: [{ text: "Sending" }], open: true }],
    ["no bytes", { blocks: [], silent: true }],
  ] as const satisfies ReadonlyArray<readonly [string, FakeReply]>)("a dispatcher request that stalls with %s closes its host at the dispatcher's deadline, fails its agent as transient, and a later agent is served on a new host", async (_kind, stall) => {
    registry = createHostRegistry();
    let stalled = false;
    await onFakeHost(temporary, (request, index) => {
      if (isDispatcher(request) && !stalled) {
        stalled = true;
        return stall;
      }
      return hostScript(lookupThenAnswer)(request, index);
    }, async ({ stage, projectRoot }) => {
      const first = await agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Find the value.").request();
      expect(first.error).toMatchObject({ failure: { _tag: "TransientNetworkFailure" } });
      expect(diagnostics.payloads("provider.claude_sdk.host.dispatcher_stalled")).toMatchObject([{ agents: 1, messages: 0, deadlineMs: DISPATCHER_STEP_DEADLINE_MS }]);
      const later = await agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Find another value.").request();
      expect(later.error).toBeUndefined();
      expect(streamedToolCalls(later)[0]?.name).toBe("lookup");
      expect(hostLaunches()).toHaveLength(2);
      await until(() => diagnostics.payloads("provider.claude_sdk.host.closed").length > 0, "the stalled host's close");
      expect(diagnostics.payloads("provider.claude_sdk.host.closed").map(({ reason }) => reason)).toEqual(["dispatcher-stalled"]);
    }, { seams: { agentHosts, dispatcherStepDeadlineMs: DISPATCHER_STEP_DEADLINE_MS } });
  }, 120_000);

  test("an undeliverable result starts the agent again, and the record names the result's kind", async () => {
    registry = createHostRegistry();
    await onFakeHost(temporary, hostScript(lookupThenAnswer), async ({ stage, projectRoot }) => {
      const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Find the value.");
      const [call] = streamedToolCalls(await agent.request());
      // The engine cuts the middle out of an error text over 10,000 characters.
      agent.result(call?.id ?? "", "x".repeat(10_001), true);
      const second = await agent.request();
      expect(second.error).toBeUndefined();
      expect(diagnostics.payloads("provider.claude_sdk.host.agent_dispatched").at(-1)).toMatchObject({ trigger: "undeliverable-result", result: "error-over-limit" });
    }, { seams: { agentHosts } });
  }, 120_000);

  test("a dispatcher request that fails is recorded once, with its status, by the next record", async () => {
    registry = createHostRegistry();
    // The engine (CLI 2.1.321) answers an HTTP 400 that it does not recognise by sending the request once more without
    // `thinking-token-count-2026-05-13`, so the host fails that resend too, and each failed request is recorded once.
    let failures = 0;
    await onFakeHost(temporary, (request, index) => {
      if (isDispatcher(request) && failures < 2) {
        failures += 1;
        return { blocks: [], status: 400 };
      }
      return hostScript(() => ({ blocks: [{ thinking: "Done." }, { text: "Done." }] }))(request, index);
    }, async ({ host, stage, projectRoot }) => {
      const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Report.");
      expect((await agent.request()).error).toBeDefined();
      const retried = await agent.request();
      expect(retried.error).toBeUndefined();
      const hidden = hiddenRequests(retried);
      expect(failures).toBe(2);
      expect(hidden.filter(({ status }) => status !== 200)).toEqual(Array.from({ length: failures }, () => ({ source: "agent-host-dispatcher", status: 400 })));
      expect(hidden.filter(({ status }) => status === 200)).toHaveLength(host.requests.filter(isDispatcher).length - failures);
    }, { seams: { agentHosts } });
  }, 120_000);

  test.each([[404, "model_not_found"], [403, "authentication_failed"], [429, "rate_limit"]] as const)(
    "a coordinator request refused with %d moves the coordinator to the next model for the host's life, and no agent, login, or quota sees the failure", async (status, kind) => {
      registry = createHostRegistry();
      const quota = fakeAvailability({});
      const refusals: Array<readonly [string, ModelRefusal]> = [];
      const outcomes: RequestOutcome[] = [];
      let refused = 0;
      const reply = (request: RecordedRequest, index: number): FakeReply => {
        if (!isDispatcher(request) || request.body["model"] !== "claude-haiku-5-5") return hostScript(lookupThenAnswer)(request, index);
        refused += 1;
        return status === 404 ? modelRefused(request) : { blocks: [], status };
      };
      await onFakeHost(temporary, reply, async ({ host, stage, projectRoot }) => {
        const first = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Find the value.");
        const served = await first.request();
        expect(served.error).toBeUndefined();
        expect(streamedToolCalls(served)[0]?.name).toBe("lookup");
        // Each request that the service refused is recorded once, with its status, by the agent's transport record:
        // after a 404 the engine sends the request again without streaming, and that resend is a request too.
        expect(refused).toBe(status === 404 ? FAILED_REQUESTS_PER_REFUSAL : 1);
        expect(hiddenRequests(served).filter((request) => request.status !== 200)).toEqual(Array.from({ length: refused }, () => ({ source: "agent-host-dispatcher", status })));
        const second = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Find another value.");
        expect((await second.request()).error).toBeUndefined();
        const models = host.requests.filter(isDispatcher).map((request) => request.body["model"]);
        expect(models.at(0)).toBe("claude-haiku-5-5");
        expect(models.slice(models.indexOf("claude-sonnet-5-5"))).toEqual(models.slice(models.indexOf("claude-sonnet-5-5")).map(() => "claude-sonnet-5-5"));
        expect(host.requests.filter((request) => !isDispatcher(request)).map((request) => request.body["model"])).toEqual(["claude-opus-5-5", "claude-opus-5-5"]);
        expect(hostLaunches()).toMatchObject([{ model: "claude-haiku-5-5", coordinators: 4 }]);
        expect(diagnostics.payloads("provider.claude_sdk.host.coordinator_demoted")).toMatchObject([{ from: "claude-haiku-5-5", to: "claude-sonnet-5-5", error: kind, status }]);
        expect(diagnostics.payloads("provider.claude_sdk.host.agent_failed")).toEqual([]);
        expect(outcomes.filter((outcome) => outcome !== "served")).toEqual([]);
        expect(quota.genericEntryCount()).toBe(0);
        expect(refusals).toEqual(status === 404 ? [["claude-haiku-5-5", { kind: "model" }]] : []);
      }, {
        model: "claude-opus-5-5",
        build: { availability: quota.availability, recordModelRefusal: (wireModelId, refusal) => { refusals.push([wireModelId, refusal]); } },
        seams: { agentHosts, observations: { ...createLoginObservations(), recordRequest: (_login, outcome) => { outcomes.push(outcome); } } },
      });
    }, 120_000);

  test("a dispatcher request that the service answers with a 404 of another resource refuses no model and moves no coordinator: the frame fails with the service's answer, and each request, the engine's resend too, is recorded once", async () => {
    registry = createHostRegistry();
    const account = accountObservers();
    let failed = 0;
    await onFakeHost(temporary, (request, index) => {
      if (isDispatcher(request) && failed < 2) {
        failed += 1;
        return { blocks: [], status: 404, error: { type: "not_found_error", message: "File not found: file_123" } };
      }
      return hostScript(lookupThenAnswer)(request, index);
    }, async ({ stage, projectRoot }) => {
      const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Find the value.");
      expect((await agent.request()).error).toMatchObject({ failure: { _tag: "InvalidRequestFailure" } });
      const retried = await agent.request();
      expect(retried.error).toBeUndefined();
      expect(failed).toBe(FAILED_REQUESTS_PER_REFUSAL);
      expect(hiddenRequests(retried).filter(({ status }) => status !== 200)).toEqual(Array.from({ length: failed }, () => ({ source: "agent-host-dispatcher", status: 404 })));
      expect(account.refusals).toEqual([]);
      expect(diagnostics.payloads("provider.claude_sdk.host.coordinator_demoted")).toEqual([]);
    }, account.options("claude-opus-5-5"));
  }, 120_000);

  test("with paid use off, a host that one client anticipated and another served stops on extra usage and tells the person through the composition's notify seam", async () => {
    registry = createHostRegistry();
    const notices: NotificationEpisodeInput[] = [];
    const overage = { "anthropic-ratelimit-unified-overage-in-use": "true", "anthropic-ratelimit-unified-overage-status": "allowed" };
    await onFakeHost(temporary, (request, index) => {
      const reply = hostScript(lookupThenAnswer)(request, index);
      return isDispatcher(request) ? reply : { ...reply, headers: overage };
    }, async ({ stage, projectRoot }) => {
      // The first client opens the host by its anticipation alone and never sends a request.
      const anticipating = await (await stage({ sharedHost: TREE })).connect();
      await anticipating.anticipate({ messages: [{ kind: "user", origin: "human", content: "Wait." }], tools: [LOOKUP], systemPrompt: SYSTEM });
      const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Find the value.");
      await agent.request();
      await until(() => notices.length > 0, "the notice");
      // The guard closed the host that served the agent.
      await until(() => diagnostics.payloads("provider.claude_sdk.host.closed").length > 0, "the host's close");
      expect(diagnostics.payloads("provider.claude_sdk.host.closed")).toMatchObject([{ reason: "extra-usage" }]);
      expect(notices).toEqual([expect.objectContaining({ type: "raise", occurrence: expect.objectContaining({ title: "Claude extra usage stopped" }) })]);
      expect(hostLaunches()).toHaveLength(1);
    }, { seams: { agentHosts }, build: { notify: (episode) => { notices.push(episode); } } });
  }, 120_000);

  test("an engine that cannot start fails the request as a route that is down, after one launch", async () => {
    registry = createHostRegistry();
    let launches = 0;
    await onFakeHost(temporary, hostScript(lookupThenAnswer), async ({ stage, projectRoot }) => {
      const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Find the value.");
      const result = await agent.request();
      expect(result.error).toMatchObject({ failure: { _tag: "RouteUnavailableFailure" } });
      expect(launches).toBe(1);
    }, { seams: { agentHosts, createHostLauncher: (config) => { const launch = createHostLauncher({ ...config, enginePath: `${config.enginePath}-missing` }); return (input) => { launches += 1; return launch(input); }; } } });
  }, 120_000);

  test("a step that the engine starts by itself is refused, and the agent's next request starts it under a new id", async () => {
    registry = createHostRegistry();
    let empty = false;
    await onFakeHost(temporary, hostScript(() => {
      if (!empty) {
        empty = true;
        return { blocks: [] };
      }
      return { blocks: [{ thinking: "Done." }, { text: "Done." }] };
    }), async ({ host, stage, projectRoot }) => {
      const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Report.");
      expect((await agent.request()).error).toBeUndefined();
      await until(() => diagnostics.payloads("provider.claude_sdk.host.step_refused").length > 0, "the refused step");
      const [first] = dispatchedIds(host.requests);
      expect(diagnostics.payloads("provider.claude_sdk.host.step_refused").map(({ agentId }) => agentId)).toEqual([first]);
      agent.history.push({ kind: "user", origin: "human", content: "Again." });
      expect((await agent.request()).error).toBeUndefined();
      expect(new Set(dispatchedIds(host.requests)).size).toBe(2);
    }, { seams: { agentHosts } });
  }, 120_000);
});

/** What the login's account sees of a host's requests: the quota marks, the request outcomes, and the refusals that
 *  the host recorded. `options` runs a case on `model` with these observers. */
function accountObservers() {
  const quota = fakeAvailability({});
  const refusals: Array<readonly [string, ModelRefusal]> = [];
  const outcomes: RequestOutcome[] = [];
  return {
    quota, refusals, outcomes,
    options: (model: string) => ({
      model,
      build: { availability: quota.availability, recordModelRefusal: (wireModelId: string, refusal: ModelRefusal) => { refusals.push([wireModelId, refusal]); } },
      seams: { agentHosts, observations: { ...createLoginObservations(), recordRequest: (_login: unknown, outcome: RequestOutcome) => { outcomes.push(outcome); } } },
    }),
  };
}

/** The fake host's answers when the service does not know the coordinator's model while `refused` holds: a 404 to each
 *  dispatcher request of that model, which `failed` counts as the HTTP requests that the service refused. */
function coordinatorRefused(refused: (request: RecordedRequest) => boolean, agent: (request: RecordedRequest, index: number) => FakeReply = lookupThenAnswer) {
  const failed = { count: 0 };
  const reply = (request: RecordedRequest, index: number): FakeReply => {
    if (isDispatcher(request) && refused(request)) {
      failed.count += 1;
      return modelRefused(request);
    }
    return hostScript(agent)(request, index);
  };
  return { failed, reply };
}

/** How many times each brief's agent started: the requests whose newest text is a dispatch's wrapper. */
function startsByBrief(requests: readonly RecordedRequest[], briefs: readonly string[]): readonly number[] {
  const starts = requests.filter((request) => !isDispatcher(request) && lastUserTexts(request).at(-1) === DISPATCH_TEXT);
  return briefs.map((brief) => starts.filter((request) => JSON.stringify(wireMessages(request)).includes(brief)).length);
}

const onHaiku = (request: RecordedRequest) => request.body["model"] === "claude-haiku-5-5";

/** The service's refusal of the request's model: a 404 whose message names the model, as the service words it. */
function modelRefused(request: RecordedRequest): FakeReply {
  return { blocks: [], status: 404, error: { type: "not_found_error", message: `model: ${String(request.body["model"])}` } };
}

/** Whether a request's newest user message holds tool results, as a dispatcher's step after its messages does. */
function answersResults(request: RecordedRequest): boolean {
  const last = wireMessages(request).findLast((message) => message.role === "user");
  return last !== undefined && typeof last.content !== "string" && last.content.some((block) => block.type === "tool_result");
}

/** The HTTP requests that one refused coordinator step costs: the engine sends its own second request after a 404. */
const FAILED_REQUESTS_PER_REFUSAL = 2;

/** The coordinator models of the fake login, cheapest first. */
const COORDINATORS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"];

describe("the shared agent host's coordinator", () => {
  test("a host that a Haiku agent opened goes on past Haiku, so an Opus agent of the host runs after the service refused the Haiku coordinator", async () => {
    registry = createHostRegistry();
    const account = accountObservers();
    const { failed, reply } = coordinatorRefused(onHaiku);
    await onFakeHost(temporary, reply, async ({ host, stage, projectRoot }) => {
      const fast = agentLoop(await stage({ sharedHost: TREE, model: { wireModelId: "claude-haiku-5-5", contextLimit: 200_000 } }), projectRoot, "Find the value.");
      expect((await fast.request()).error).toBeUndefined();
      const deep = agentLoop(await stage({ sharedHost: TREE, model: { wireModelId: "claude-opus-5-5", contextLimit: 1_000_000 } }), projectRoot, "Find another value.");
      expect((await deep.request()).error).toBeUndefined();
      expect(hostLaunches()).toMatchObject([{ model: "claude-haiku-5-5", coordinators: 4 }]);
      expect(diagnostics.payloads("provider.claude_sdk.host.coordinator_demoted")).toMatchObject([{ from: "claude-haiku-5-5", to: "claude-sonnet-5-5" }]);
      expect(host.requests.filter((request) => !isDispatcher(request)).map((request) => request.body["model"])).toEqual(["claude-haiku-5-5", "claude-opus-5-5"]);
      expect(account.refusals).toEqual([["claude-haiku-5-5", { kind: "model" }]]);
      expect(failed.count).toBe(FAILED_REQUESTS_PER_REFUSAL);
    }, account.options("claude-haiku-5-5"));
  }, 120_000);

  test("a host whose every coordinator model the service refuses records each refusal and fails its agent as transient", async () => {
    registry = createHostRegistry();
    const account = accountObservers();
    const { failed, reply } = coordinatorRefused(() => true);
    await onFakeHost(temporary, reply, async ({ stage, projectRoot }) => {
      const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Find the value.");
      const result = await agent.request();
      expect(result.error).toMatchObject({ failure: { _tag: "TransientNetworkFailure" } });
      // The agent's own model is refused only because its coordinator step got a 404.
      expect(account.refusals).toEqual(COORDINATORS.map((model) => [model, { kind: "model" }]));
      expect(diagnostics.payloads("provider.claude_sdk.host.coordinator_demoted").map(({ to }) => to)).toEqual(COORDINATORS.slice(1));
      expect(diagnostics.payloads("provider.claude_sdk.host.coordinator_exhausted")).toMatchObject([{ from: "claude-fable-5-1", to: "claude-haiku-5-5", error: "model_not_found" }]);
      expect(failed.count).toBe(COORDINATORS.length * FAILED_REQUESTS_PER_REFUSAL);
      expect(account.outcomes.filter((outcome) => outcome === "login-rejected")).toEqual([]);
      expect(account.quota.genericEntryCount()).toBe(0);
    }, account.options("claude-haiku-5-5"));
  }, 120_000);

  test("a Haiku agent whose Haiku coordinator is rate limited and whose other coordinators are refused keeps its own model unrefused", async () => {
    registry = createHostRegistry();
    const account = accountObservers();
    await onFakeHost(temporary, (request, index) => isDispatcher(request) ? (onHaiku(request) ? { blocks: [], status: 429 } : modelRefused(request)) : hostScript(lookupThenAnswer)(request, index), async ({ stage, projectRoot }) => {
      const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Find the value.");
      expect((await agent.request()).error).toMatchObject({ failure: { _tag: "TransientNetworkFailure" } });
      expect(account.refusals).toEqual(COORDINATORS.slice(1).map((model) => [model, { kind: "model" }]));
      expect(account.outcomes.filter((outcome) => outcome === "login-rejected")).toEqual([]);
      expect(account.quota.genericEntryCount()).toBe(0);
    }, account.options("claude-haiku-5-5"));
  }, 120_000);

  test("after every coordinator model failed, the host's next frame starts again at the first model", async () => {
    registry = createHostRegistry();
    const account = accountObservers();
    let limited = true;
    await onFakeHost(temporary, (request, index) => isDispatcher(request) && limited ? { blocks: [], status: 429 } : hostScript(lookupThenAnswer)(request, index), async ({ host, stage, projectRoot }) => {
      const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Find the value.");
      expect((await agent.request()).error).toMatchObject({ failure: { _tag: "TransientNetworkFailure" } });
      expect(diagnostics.payloads("provider.claude_sdk.host.coordinator_exhausted")).toHaveLength(1);
      limited = false;
      const served = host.requests.length;
      expect((await agent.request()).error).toBeUndefined();
      expect(host.requests.slice(served).find(isDispatcher)?.body["model"]).toBe("claude-haiku-5-5");
      expect(hostLaunches()).toHaveLength(1);
      expect(account.refusals).toEqual([]);
      expect(account.quota.genericEntryCount()).toBe(0);
    }, account.options("claude-opus-5-5"));
  }, 120_000);

  test("concurrent agents that wait on a refused coordinator each start once on the next model", async () => {
    registry = createHostRegistry();
    const account = accountObservers();
    const { failed, reply } = coordinatorRefused(onHaiku);
    await onFakeHost(temporary, reply, async ({ host, stage, projectRoot }) => {
      const briefs = Array.from({ length: 4 }, (_, index) => `Task ${index}.`);
      const agents = await Promise.all(briefs.map(async (brief) => agentLoop(await stage({ sharedHost: TREE }), projectRoot, brief)));
      const results = await Promise.all(agents.map((agent) => agent.request()));
      expect(results.map((result) => result.error)).toEqual(results.map(() => undefined));
      expect(startsByBrief(host.requests, briefs)).toEqual(briefs.map(() => 1));
      expect(diagnostics.payloads("provider.claude_sdk.host.coordinator_demoted")).toHaveLength(1);
      expect(failed.count).toBe(FAILED_REQUESTS_PER_REFUSAL);
      expect(account.outcomes.filter((outcome) => outcome !== "served")).toEqual([]);
      expect(account.quota.genericEntryCount()).toBe(0);
    }, account.options("claude-opus-5-5"));
  }, 120_000);

  test("a coordinator refused after it started one agent of its frame starts only the other agent again, on the next model", async () => {
    registry = createHostRegistry();
    const account = accountObservers();
    let split = false;
    // The Haiku coordinator serves frames of one agent. In the first frame of several agents it sends one message,
    // and the service refuses its next step.
    const { failed, reply } = coordinatorRefused((request) => split && onHaiku(request) && answersResults(request));
    const script = (request: RecordedRequest, index: number): FakeReply => {
      const ids = lastUserTexts(request).join("\n").match(/\ba[0-9a-f]{16}\b/gu) ?? [];
      if (isDispatcher(request) && onHaiku(request) && !split && ids.length > 1) {
        split = true;
        return { blocks: [{ tool: "SendMessage", input: { to: ids[0], message: "Continue." } }] };
      }
      return reply(request, index);
    };
    await onFakeHost(temporary, script, async ({ host, stage, projectRoot }) => {
      const briefs = Array.from({ length: 3 }, (_, index) => `Task ${index}.`);
      const agents = await Promise.all(briefs.map(async (brief) => agentLoop(await stage({ sharedHost: TREE }), projectRoot, brief)));
      const results = await Promise.all(agents.map((agent) => agent.request()));
      expect(split).toBe(true);
      expect(results.map((result) => result.error)).toEqual(results.map(() => undefined));
      expect(startsByBrief(host.requests, briefs)).toEqual(briefs.map(() => 1));
      expect(diagnostics.payloads("provider.claude_sdk.host.coordinator_demoted")).toMatchObject([{ from: "claude-haiku-5-5", to: "claude-sonnet-5-5" }]);
      expect(failed.count).toBe(FAILED_REQUESTS_PER_REFUSAL);
      expect(account.outcomes.filter((outcome) => outcome !== "served")).toEqual([]);
      expect(account.quota.genericEntryCount()).toBe(0);
    }, account.options("claude-opus-5-5"));
  }, 120_000);

  test("a coordinator refused in a resume frame resumes the agent once on the next model", async () => {
    registry = createHostRegistry();
    const account = accountObservers();
    let refusing = false;
    const { failed, reply } = coordinatorRefused((request) => refusing && onHaiku(request));
    await onFakeHost(temporary, reply, async ({ host, stage, projectRoot }) => {
      const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Find the value.");
      const first = await agent.request();
      agent.result(streamedToolCalls(first)[0]?.id ?? "", "VALUE");
      expect(streamedText(await agent.request())).toBe("The value is ready.");
      refusing = true;
      agent.history.push({ kind: "user", origin: "human", content: "Say it again." });
      const resumed = await agent.request();
      expect(resumed.error).toBeUndefined();
      expect(startsByBrief(host.requests, ["Find the value."])).toEqual([2]);
      expect(diagnostics.payloads("provider.claude_sdk.host.agent_dispatched").map(({ resumed: wasResumed }) => wasResumed)).toEqual([false, true]);
      expect(diagnostics.payloads("provider.claude_sdk.host.coordinator_demoted")).toMatchObject([{ from: "claude-haiku-5-5", to: "claude-sonnet-5-5" }]);
      expect(failed.count).toBe(FAILED_REQUESTS_PER_REFUSAL);
      expect(account.outcomes.filter((outcome) => outcome !== "served")).toEqual([]);
      expect(account.quota.genericEntryCount()).toBe(0);
    }, account.options("claude-opus-5-5"));
  }, 120_000);
});
