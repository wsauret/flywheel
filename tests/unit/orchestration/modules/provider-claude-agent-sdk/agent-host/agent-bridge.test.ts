import { describe, expect, test } from "bun:test";
import { Effect, Exit, Schema, Scope } from "effect";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerModelInfo } from "../../../../../../src/infra/llm/provider-model-info.js";
import { prepareAnthropicRequest, type AnthropicOperations } from "../../../../../../src/orchestration/agent-runtime/llm/anthropic.js";
import { environmentReminder } from "../../../../../../src/orchestration/agent-runtime/llm/claude-reminders.js";
import { FUNCTION_TOOL_PRESENTATION, type ConversationMessage, type ProviderDemand, type StreamOptions, type ToolPresentation } from "../../../../../../src/orchestration/agent-runtime/llm/types.js";
import { TOOL_MCP_PREFIX } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/names.js";
import { originsOf } from "../_bridge-harness.js";
import type { BridgeRequest } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/cli-view.js";
import { createHostedAgent, type HostedAgentConfig } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/agent-bridge.js";
import { agentFilePath } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/agent-file.js";
import { conversationTierEntry, createHostedAgentEntries, DISPATCH_TEXT, ENGINE_INSTRUCTIONS } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/engine-text.js";
import type { HostStepItem } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/host-gate.js";
import { releaseLiveBridges, resumeLiveBridges } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/live-bridges.js";
import { createHostRegistry, hostKey, type HostRegistry } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/host-registry.js";
import type { AgentHost } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/host.js";
import { temporaryDirectories } from "../../../../../helpers/directories.js";
import { holdSharedTree } from "../../../../../../src/orchestration/agent-runtime/shared-tree.js";
import { composeFirstPartyModules } from "../../../../../../src/orchestration/modules.js";
import { silentVersions } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/stderr-signals.js";

const directory = temporaryDirectories();
/** The chat tree of every agent of this suite, which the suite holds while it runs. */
const TREE = holdSharedTree("tree", () => ({ modules: composeFirstPartyModules(), shellWriteGuard: true })).tree;

/** The fields of an agent file row that the drift test reads. */
const AgentFileRow = Schema.Struct({
  type: Schema.String,
  message: Schema.optionalKey(Schema.Struct({ content: Schema.Union([Schema.String, Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) }))]) })),
  attachment: Schema.optionalKey(Schema.Struct({
    type: Schema.String, snapshot: Schema.optionalKey(Schema.Struct({ workingDirectory: Schema.String })), changes: Schema.optionalKey(Schema.Unknown),
  })),
});

/** The environment reminder that canonical history holds for an agent in `cwd`. */
function environment(cwd: string): string {
  return environmentReminder({ kind: "environment", workingDirectory: cwd, isWorktree: false, isGitRepo: false, platform: "darwin", shell: "zsh", osVersion: "Darwin 25.3.0" });
}

const unused = (): never => { throw new Error("the bridge stops at the host it leased"); };

const LOOKUP = { name: "lookup", description: "Looks a key up.", input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } };
/** The tool names that a hosted client sends: each under the runtime MCP prefix, as its engine declares them. */
const MCP_TOOLS: ToolPresentation = { ...FUNCTION_TOOL_PRESENTATION, wireName: (name) => `${TOOL_MCP_PREFIX}${name}` };

/** What the bridge asked of the hosts that it leased: each key, and the model of each agent definition. */
interface Leased {
  readonly keys: string[];
  readonly definitionModels: string[];
}

/** A registry that records each leased key and hands out a host that records the model of the agent's definition and
 *  then fails the bridge's dispatch. */
function recordingRegistry(leased: Leased): HostRegistry {
  const host: AgentHost = {
    sessionId: "host", folder: { configDir: "/scratch", cwd: "/scratch", sessionId: "host" }, get toolGate() { return unused(); },
    definition: (_prompt, model) => { leased.definitionModels.push(model); return unused(); },
    admit: unused, dispatch: unused, settled: unused, stopTask: unused, takeHiddenRequests: unused, released: unused, requestFailure: unused,
    ended: new Promise(() => {}), served: false, close: async () => {},
  };
  return { lease: (place) => { leased.keys.push(hostKey(place)); return { host, opened: true, release: async () => {} }; }, drain: async () => {} };
}

interface Agent {
  readonly model: string;
  readonly contextLimit: number;
  readonly effort?: "low" | "high";
  readonly thinking?: { readonly type: "adaptive" } | { readonly type: "enabled"; readonly budget_tokens: number };
  readonly maxTokens?: number;
  /** The directory that the agent's environment reminder states, else none. */
  readonly cwd?: string;
}

/** Leases a host for the first request of each agent in `agents`, in order. */
async function lease(agents: readonly Agent[]): Promise<Leased> {
  const leased: Leased = { keys: [], definitionModels: [] };
  const registry = recordingRegistry(leased);
  for (const { model, contextLimit, effort = "low", thinking = { type: "adaptive" as const }, maxTokens = 64_000, cwd } of agents) {
    const config: HostedAgentConfig = {
      registry, launchHost: unused, configDir: "/scratch", tree: TREE, login: "login", projectRoot: tmpdir(), wireModelId: model, contextLimit, lineup: () => [], recordModelRefusal: () => {},
      markQuotaExhausted: unused, extraUsage: "refuse", reportsExtraUsage: () => false, accountEmail: () => undefined, engineShell: () => undefined, onExtraUsageStop: () => {}, recordUsage: () => {}, recordOutcome: () => {}, ownEngine: unused, silentVersions: silentVersions(),
    };
    const request: BridgeRequest = {
      model, max_tokens: maxTokens, stream: true, thinking, output_config: { effort }, system: [{ type: "text", text: "You review one claim." }],
      messages: [{ role: "user", content: [
        { type: "text", text: "Refute the claim." }, ...(cwd === undefined ? [] : [{ type: "text" as const, text: environment(cwd) }]), { type: "text", text: DISPATCH_TEXT },
      ] }],
    };
    await createHostedAgent(config).operations.createStream(request, { origins: originsOf(request), sharedHost: true, signal: new AbortController().signal, headers: {} }).catch(() => undefined);
  }
  return leased;
}

describe("the hosted agent's host", () => {
  test("agents that differ only in effort lease one host, because the gate states each step's effort", async () => {
    const { keys } = await lease([{ model: "claude-sonnet-5-5", contextLimit: 200_000, effort: "low" }, { model: "claude-sonnet-5-5", contextLimit: 200_000, effort: "high" }]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  test("agents on different Claude models with equal request values lease one host, whatever the values, and each definition states its agent's model as the engine spells it", async () => {
    const { keys, definitionModels } = await lease([{ model: "claude-haiku-5-5", contextLimit: 200_000 }, { model: "claude-opus-5-5", contextLimit: 1_000_000 }]);
    expect(new Set(keys).size).toBe(1);
    expect(definitionModels).toEqual(["claude-haiku-5-5", "claude-opus-5-5[1m]"]);
    for (const values of [{ maxTokens: 128_001 }, { thinking: { type: "enabled", budget_tokens: 16_000 } as const }]) {
      const shared = await lease([{ model: "claude-haiku-5-5", contextLimit: 200_000, ...values }, { model: "claude-opus-5-5", contextLimit: 200_000, ...values }]);
      expect(new Set(shared.keys).size).toBe(1);
    }
  });

  test("agents whose request values differ lease a host each", async () => {
    const { keys } = await lease([{ model: "claude-opus-5-5", contextLimit: 200_000 }, { model: "claude-opus-5-5", contextLimit: 200_000, maxTokens: 128_001 }]);
    expect(new Set(keys).size).toBe(2);
  });

  test("agents in two directories of one git status lease one host, and an agent in a directory of another git status leases another", async () => {
    const repository = directory("hosted-repository-");
    mkdirSync(join(repository, ".git"));
    const { keys } = await lease([directory("hosted-a-"), directory("hosted-b-"), repository].map((cwd) => ({ model: "claude-opus-5-5", contextLimit: 200_000, cwd })));
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  test("a dispatch writes the agent's directory into its meta file, and every environment row of the agent file states that directory with no change", async () => {
    const hostCwd = directory("hosted-host-");
    const agentCwd = directory("hosted-agent-");
    const folder = { configDir: directory("hosted-login-"), cwd: hostCwd, sessionId: "host" };
    const written: string[] = [];
    const host: AgentHost = {
      sessionId: "host", folder, get toolGate() { return unused(); },
      definition: () => "flywheel-agents:agent", admit: async () => ({ close: () => {} }), settled: async () => {}, stopTask: () => {}, takeHiddenRequests: unused, released: unused, requestFailure: unused,
      // The dispatch reads the files that the bridge wrote for it, as the engine does, and then fails the request.
      dispatch: async (agentId) => {
        const path = agentFilePath(folder, agentId);
        written.push(readFileSync(path.replace(/\.jsonl$/u, ".meta.json"), "utf8"), readFileSync(path, "utf8"));
        throw new Error("the test reads the files only");
      },
      ended: new Promise(() => {}), served: false, close: async () => {},
    };
    const config: HostedAgentConfig = {
      registry: { lease: () => ({ host, opened: true, release: async () => {} }), drain: async () => {} }, launchHost: unused, configDir: folder.configDir, tree: TREE, login: "login", projectRoot: hostCwd,
      wireModelId: "claude-opus-5-5", contextLimit: 200_000, lineup: () => [], recordModelRefusal: () => {}, markQuotaExhausted: unused, extraUsage: "refuse", reportsExtraUsage: () => false,
      accountEmail: () => undefined, engineShell: () => undefined, onExtraUsageStop: () => {}, recordUsage: () => {}, recordOutcome: () => {}, ownEngine: unused, silentVersions: silentVersions(),
    };
    // The agent's second dispatch: its file holds the first, and the environment row of its opening message.
    const request: BridgeRequest = {
      model: "claude-opus-5-5", max_tokens: 64_000, stream: true, thinking: { type: "adaptive" }, output_config: { effort: "low" }, system: [{ type: "text", text: "You review one claim." }],
      messages: [
        { role: "user", content: [{ type: "text", text: "Refute the claim." }, { type: "text", text: environment(agentCwd) }, { type: "text", text: DISPATCH_TEXT }] },
        { role: "assistant", content: [{ type: "text", text: "Refuted." }] },
        { role: "user", content: [{ type: "text", text: "Refute the next claim." }, { type: "text", text: DISPATCH_TEXT }] },
      ],
    };
    await createHostedAgent(config).operations.createStream(request, { origins: originsOf(request), sharedHost: true, signal: new AbortController().signal, headers: {} }).catch(() => undefined);
    const [meta = "", file = ""] = written;
    expect(JSON.parse(meta)).toMatchObject({ cwd: agentCwd });
    const rows = file.trim().split("\n").map((line) => Schema.decodeUnknownSync(AgentFileRow)(JSON.parse(line)));
    const environments = rows.flatMap(({ attachment }) => attachment?.type === "environment" ? [attachment] : []);
    expect(environments.map(({ snapshot, changes }) => ({ cwd: snapshot?.workingDirectory, changes }))).toEqual([{ cwd: agentCwd, changes: undefined }]);
    expect(rows.filter((row) => row.type === "user" && typeof row.message?.content !== "string" && row.message?.content.some((block) => block.text === DISPATCH_TEXT))).toHaveLength(1);
  });
});

describe("a hosted agent's anticipated request", () => {
  /** A host whose end the test decides. */
  const fakeHost = (served = false) => {
    const ended = Promise.withResolvers<Error>();
    const host: AgentHost = {
      sessionId: "host", folder: { configDir: "/scratch", cwd: "/scratch", sessionId: "host" }, get toolGate() { return unused(); },
      definition: unused, admit: unused, dispatch: unused, settled: unused, stopTask: unused, takeHiddenRequests: unused, released: unused, requestFailure: unused,
      ended: ended.promise, served, close: async (_reason, error) => { ended.resolve(error ?? new Error("closed")); },
    };
    return { host, end: (error: Error) => { ended.resolve(error); } };
  };
  /** A registry that records each lease of `host`. */
  const leaseRecorder = (host: AgentHost) => {
    const leases: { readonly key: string; released: boolean }[] = [];
    const registry: HostRegistry = {
      lease: (place) => {
        const leased = { key: hostKey(place), released: false };
        leases.push(leased);
        return { host, opened: true, release: async () => { leased.released = true; } };
      },
      drain: async () => {},
    };
    return { registry, leases };
  };
  const anticipate = (agent: ReturnType<typeof createHostedAgent>, sharedHost = true, maxTokens?: number) => {
    const request = hostedRequest("(next message)", maxTokens);
    return agent.operations.anticipate?.(request, { origins: originsOf(request), sharedHost });
  };

  test("of a session shares one lease of its host place across the session's roles and clients, and the last claim's release ends it", async () => {
    const { host } = fakeHost();
    const { registry, leases } = leaseRecorder(host);
    const owner = watchDemand();
    const first = createHostedAgent({ ...hostedConfig(registry), demand: owner.demand });

    expect(await anticipate(first, false)).toBeUndefined();
    expect(leases).toEqual([]);
    const claims = [await anticipate(first), await anticipate(first), await anticipate(first)];
    expect(new Set(claims).size).toBe(3);
    // A newer client of the session, as a replanned role or a reattach makes, keeps the session's lease.
    await first.close("lifetime-end");
    const second = createHostedAgent({ ...hostedConfig(registry), demand: owner.demand });
    const renewed = await anticipate(second);
    expect(leases).toEqual([{ key: expect.any(String), released: false }]);

    for (const claim of claims) await claim?.release();
    expect(leases).toEqual([{ key: expect.any(String), released: false }]);
    await renewed?.release();
    expect(leases).toEqual([{ key: expect.any(String), released: true }]);
    await second.close("lifetime-end");
    await owner.close();
  });

  test("without a session's demand holds a lease of its own until its owner releases the claim", async () => {
    const { host } = fakeHost();
    const { registry, leases } = leaseRecorder(host);
    const agent = createHostedAgent(hostedConfig(registry));
    const [one, two] = [await anticipate(agent), await anticipate(agent)];
    expect(leases).toHaveLength(2);
    await one?.release();
    await one?.release();
    expect(leases.map(({ released }) => released)).toEqual([true, false]);
    await two?.release();
    expect(leases.map(({ released }) => released)).toEqual([true, true]);
    await agent.close("lifetime-end");
  });

  test("whose host cannot open, as for an agent directory that is gone, claims nothing", async () => {
    // The agent's directory lies in a git repository and the project root does not, so its host runs in the agent's
    // directory, which no longer exists.
    const repository = directory("hosted-repository-");
    mkdirSync(join(repository, ".git"));
    const owner = watchDemand();
    const agent = createHostedAgent({
      ...hostedConfig({ lease: (_place, open) => ({ host: open(), opened: true, release: async () => {} }), drain: async () => {} }),
      projectRoot: directory("hosted-project-"), demand: owner.demand,
    });
    const request = hostedRequest("(next message)");
    const gone = { ...request, messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "(next message)" }, { type: "text" as const, text: environment(join(repository, "gone")) }, { type: "text" as const, text: DISPATCH_TEXT }] }] };

    expect(await agent.operations.anticipate?.(gone, { origins: originsOf(gone), sharedHost: true })).toBeUndefined();
    await agent.close("lifetime-end");
    await owner.close();
  });

  test.each([
    ["the module turned off", (_registry: HostRegistry) => { releaseLiveBridges(); }, false, 1],
    ["a drain at shutdown", (registry: HostRegistry) => registry.drain(), false, 0],
  ] as const)("on a host that %s closes asks the session to plan again %d times", async (_name, drain, served, stale) => {
    const registry = createHostRegistry();
    const { host } = fakeHost(served);
    const owner = watchDemand();
    const agent = createHostedAgent({ ...hostedConfig({ lease: (place) => registry.lease(place, () => host), drain: registry.drain }), demand: owner.demand });
    const claims = [await anticipate(agent), await anticipate(agent)];
    expect(claims.every((claim) => claim !== undefined)).toBe(true);

    await drain(registry);
    await Promise.resolve();
    await Promise.resolve();
    expect(owner.stale()).toBe(stale);
    await agent.close("lifetime-end");
    await owner.close();
  });

  test.each([
    [true, 1],
    [false, 0],
  ] as const)("on a host that ends by itself, which served: %p, asks the session to plan again %d times, once for every claim on it", async (served, stale) => {
    const { host, end } = fakeHost(served);
    const { registry, leases } = leaseRecorder(host);
    const owner = watchDemand();
    const agent = createHostedAgent({ ...hostedConfig(registry), demand: owner.demand });
    await anticipate(agent);
    await anticipate(agent);
    end(new Error("the host's engine exited"));
    await Promise.resolve();
    await Promise.resolve();
    expect({ stale: owner.stale(), leases }).toEqual({ stale, leases: [{ key: expect.any(String), released: true }] });
    // The next plan's claim leases a new host.
    await anticipate(agent);
    expect(leases).toHaveLength(2);
    await agent.close("lifetime-end");
    await owner.close();
  });

  test("of a session whose demand closes releases what the session's claims hold", async () => {
    const { host } = fakeHost();
    const { registry, leases } = leaseRecorder(host);
    const owner = watchDemand();
    const agent = createHostedAgent({ ...hostedConfig(registry), demand: owner.demand });
    await anticipate(agent);
    await anticipate(agent, true, 128_001);
    expect(leases.map(({ released }) => released)).toEqual([false, false]);
    await owner.close();
    expect(leases.map(({ released }) => released)).toEqual([true, true]);
    await agent.close("lifetime-end");
  });
});

/** A session's engine demand that counts each ask to plan again. */
function watchDemand() {
  let stale = 0;
  const scope = Scope.makeUnsafe("sequential");
  const demand: ProviderDemand = { scope, stale: () => { stale += 1; } };
  return { demand, stale: () => stale, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
}

function hostedConfig(registry: HostRegistry): HostedAgentConfig {
  return {
    registry, launchHost: unused, configDir: "/scratch", tree: TREE, login: "login", projectRoot: tmpdir(), wireModelId: "claude-sonnet-5-5", contextLimit: 200_000, lineup: () => [], recordModelRefusal: () => {},
    markQuotaExhausted: unused, extraUsage: "refuse", reportsExtraUsage: () => false, accountEmail: () => undefined, engineShell: () => undefined, onExtraUsageStop: () => {}, recordUsage: () => {}, recordOutcome: () => {}, ownEngine: unused, silentVersions: silentVersions(),
  };
}

function hostedRequest(text: string, maxTokens = 64_000): BridgeRequest {
  return {
    model: "claude-sonnet-5-5", max_tokens: maxTokens, stream: true, thinking: { type: "adaptive" }, output_config: { effort: "low" }, system: [{ type: "text", text: "You review one claim." }],
    messages: [{ role: "user", content: [{ type: "text", text }, { type: "text", text: DISPATCH_TEXT }] }],
  };
}

describe("a hosted agent's request that its consumer leaves", () => {
  /** One agent on a host whose admitted step streams `items`, with each task stop that the bridge asked for. */
  function scriptedAgent(items: readonly HostStepItem[]) {
    const stops: (readonly [string, string])[] = [];
    const host: AgentHost = {
      sessionId: "host", folder: { configDir: directory("hosted-login-"), cwd: directory("hosted-host-"), sessionId: "host" }, get toolGate() { return unused(); },
      definition: () => "flywheel-agents:agent", settled: async () => {}, takeHiddenRequests: () => [], released: () => {}, requestFailure: unused, dispatch: async () => {},
      admit: async (_agentId, _values, sink) => {
        for (const item of items) sink.item(item);
        return { close: () => {} };
      },
      stopTask: (agentId, cause) => { stops.push([agentId, cause]); },
      ended: new Promise(() => {}), served: false, close: async () => {},
    };
    const leases = { released: 0 };
    const agent = createHostedAgent(hostedConfig({ lease: () => ({ host, opened: true, release: async () => { leases.released += 1; } }), drain: async () => {} }));
    const caller = new AbortController();
    const open = () => agent.operations.createStream(hostedRequest("Find the value."), { origins: originsOf(hostedRequest("Find the value.")), sharedHost: true, signal: caller.signal, headers: {} });
    return { agent, stops, leases, caller, open };
  }

  test("a caller's abort while the consumer waits for the next event fails the read and stops that agent's task, and the bridge keeps its host", async () => {
    const { agent, stops, leases, caller, open } = scriptedAgent([{ kind: "text", index: 0, text: "Partial" }]);
    const { data } = await open();
    const stopped = new Error("the person stopped the turn");
    const read = (async () => { for await (const _ of data) { /* the consumer reads until the stream fails */ } })().then(() => undefined, (error: unknown) => error);
    await Promise.resolve();
    caller.abort(stopped);
    expect(await read).toBe(stopped);
    expect(stops).toEqual([[expect.any(String), "abort"]]);
    expect(leases.released).toBe(0);
    await agent.close("lifetime-end");
    expect(leases.released).toBe(1);
  });

  test("stops that agent's task once when the adapter releases the unfinished stream, also when the caller's signal aborts after it", async () => {
    const { agent, stops, caller, open } = scriptedAgent([{ kind: "text", index: 0, text: "Partial" }]);
    const { data } = await open();
    // oxlint-disable-next-line no-unreachable-loop -- the adapter reads one chunk and leaves the loop, which releases the unfinished stream
    for await (const _ of data) break;
    data.controller.abort();
    expect(stops).toEqual([[expect.any(String), "abort"]]);
    caller.abort(new Error("the person stopped the turn"));
    await agent.close("lifetime-end");
    expect(stops).toHaveLength(1);
  });

  test("keeps the agent parked when the adapter releases a stream that it read to its tool call's end", async () => {
    const { agent, stops, open } = scriptedAgent([
      { kind: "tool", index: 0, id: "toolu_1", name: "lookup" }, { kind: "input", index: 0, json: "{\"key\":\"k\"}" }, { kind: "stop", stopReason: "tool_use", usage: null },
    ]);
    const { data } = await open();
    for await (const _ of data) { /* the adapter reads the whole response, then releases it */ }
    data.controller.abort();
    expect(stops).toEqual([]);
    // Only a parked agent has a task for its lifetime's end to stop.
    await agent.close("lifetime-end");
    expect(stops).toEqual([[expect.any(String), "lifetime-end"]]);
  });
});

describe("the module turned off", () => {
  test("ends a session's claims and an idle agent's host at once, and the host of a running request once that request settled, which it does in full", async () => {
    const registry = createHostRegistry();
    const closes: string[] = [];
    const stops: string[] = [];
    /** Opens a host whose every admitted step answers in full. */
    const open = (sessionId: string): AgentHost => {
      const ended = Promise.withResolvers<Error>();
      return {
        sessionId, folder: { configDir: directory("hosted-login-"), cwd: directory("hosted-host-"), sessionId }, get toolGate() { return unused(); },
        definition: () => "flywheel-agents:agent", settled: async () => {}, takeHiddenRequests: () => [], released: () => {}, requestFailure: unused, dispatch: async () => {},
        admit: async (_agentId, _values, sink) => {
          sink.item({ kind: "text", index: 0, text: "Done." });
          sink.item({ kind: "stop", stopReason: "end_turn", usage: null });
          return { close: () => {} };
        },
        stopTask: (_agentId, cause) => { stops.push(cause); },
        ended: ended.promise, served: true,
        close: async (reason) => { closes.push(`${sessionId}: ${reason}`); ended.resolve(new Error(reason)); },
      };
    };
    const owner = watchDemand();
    const agent = (sessionId: string) => createHostedAgent({ ...hostedConfig({ lease: (place) => registry.lease(place, () => open(sessionId)), drain: registry.drain }), demand: owner.demand });
    const send = (hosted: ReturnType<typeof agent>, maxTokens?: number) => {
      const request = hostedRequest("Find the value.", maxTokens);
      return hosted.operations.createStream(request, { origins: originsOf(request), sharedHost: true, signal: new AbortController().signal, headers: {} });
    };
    const read = async (data: AsyncIterable<unknown>) => {
      const events: unknown[] = [];
      for await (const event of data) events.push(event);
      return events;
    };
    // An idle agent whose request ended, on the host that the session's claim also holds.
    const idle = agent("idle");
    const request = hostedRequest("(next message)");
    expect(await idle.operations.anticipate?.(request, { origins: originsOf(request), sharedHost: true })).toBeDefined();
    const answered = await send(idle);
    await read(answered.data);
    answered.data.controller.abort();
    // A running agent on a host of other values, whose response no consumer has read yet.
    const running = agent("running");
    const { data } = await send(running, 128_001);

    releaseLiveBridges();
    await Promise.resolve();
    expect({ closes, stale: owner.stale() }).toEqual({ closes: ["idle: released"], stale: 1 });

    expect(JSON.stringify(await read(data))).toContain("Done.");
    expect(closes).toEqual(["idle: released"]);
    data.controller.abort();
    await Promise.resolve();
    expect({ closes, stops }).toEqual({ closes: ["idle: released", "running: released"], stops: [] });
    await Promise.all([idle.close("lifetime-end"), running.close("lifetime-end"), owner.close()]);
  });

  test.each([
    ["ends the host that it then leases once it settled, with a session's demand", true, false],
    ["ends the host that it then leases once it settled, without a session's demand", false, false],
    ["and on again before it streams keeps its host", false, true],
  ] as const)("while an admitted request waits after its anticipation, the module turned off %s", async (_name, withDemand, onAgain) => {
    const registry = createHostRegistry();
    const closes: string[] = [];
    const stops: string[] = [];
    const host: AgentHost = {
      sessionId: "host", folder: { configDir: directory("hosted-login-"), cwd: directory("hosted-host-"), sessionId: "host" }, get toolGate() { return unused(); },
      definition: () => "flywheel-agents:agent", settled: async () => {}, takeHiddenRequests: () => [], released: () => {}, requestFailure: unused, dispatch: async () => {},
      admit: async (_agentId, _values, sink) => {
        for (const item of [
          { kind: "tool", index: 0, id: "toolu_1", name: "lookup" }, { kind: "input", index: 0, json: "{\"key\":\"k\"}" }, { kind: "stop", stopReason: "tool_use", usage: null },
        ] as const satisfies readonly HostStepItem[]) sink.item(item);
        return { close: () => {} };
      },
      stopTask: (_agentId, cause) => { stops.push(cause); },
      ended: new Promise(() => {}), served: true,
      close: async (reason) => { closes.push(reason); },
    };
    const owner = watchDemand();
    const agent = createHostedAgent({ ...hostedConfig({ lease: (place) => registry.lease(place, () => host), drain: registry.drain }), ...(withDemand ? { demand: owner.demand } : {}) });
    const request = hostedRequest("Find the value.");
    // The prompt-prefix hold: the request's anticipation claims its host, and the request streams later.
    const claim = await agent.operations.anticipate?.(request, { origins: originsOf(request), sharedHost: true });
    expect(claim).toBeDefined();
    releaseLiveBridges();
    if (onAgain) resumeLiveBridges();
    await Promise.resolve();
    // The session's claim serves no request, so its host closes at once; a claim of the request's own holds it.
    const atRelease = withDemand ? ["released"] : [];
    expect(closes).toEqual(atRelease);
    const { data } = await agent.operations.createStream(request, { origins: originsOf(request), sharedHost: true, signal: new AbortController().signal, headers: {} });
    for await (const _ of data) { /* the adapter reads the whole response, then releases it */ }
    expect(closes).toEqual(atRelease);
    data.controller.abort();
    await Promise.resolve();
    await claim?.release();
    const settled = onAgain ? [] : [...atRelease, "released"];
    expect({ closes, stops }).toEqual({ closes: settled, stops: [] });
    await agent.close("lifetime-end");
    await owner.close();
    expect(closes).toEqual(onAgain ? ["released"] : settled);
  });
});

describe("a hosted agent's request that no host can serve", () => {
  test("stops the waiting agent for its own engine, which reads no host framing, and the next hostable request starts a new agent", async () => {
    const MODEL = "claude-haiku-5-5";
    const info = providerModelInfo({ provider: "anthropic", id: MODEL, contextLimit: 200_000, outputLimit: 64_000, reasoning: true });
    const folder = { configDir: directory("hosted-login-"), cwd: directory("hosted-host-"), sessionId: "host" };
    const tiers = ["# Session identity\n\nYou are session one.", "# Session identity\n\nYou are session one, after its model change."];
    // Each admitted step answers with the next scripted answer: a lookup that parks the agent, then a reply.
    const answers: HostStepItem[][] = [
      [{ kind: "tool", index: 0, id: "toolu_1", name: "lookup" }, { kind: "input", index: 0, json: "{\"key\":\"k\"}" }, { kind: "stop", stopReason: "tool_use", usage: null }],
      [{ kind: "text", index: 0, text: "Done." }, { kind: "stop", stopReason: "end_turn", usage: null }],
    ];
    const dispatched: string[] = [];
    const stops: (readonly [string, string])[] = [];
    let releases = 0;
    const host: AgentHost = {
      sessionId: "host", folder, get toolGate() { return unused(); },
      definition: () => "flywheel-agents:agent", settled: async () => {}, takeHiddenRequests: () => [], released: () => {}, requestFailure: unused,
      admit: async (_agentId, _values, sink) => {
        for (const item of answers.shift() ?? []) sink.item(item);
        return { close: () => {} };
      },
      dispatch: async (agentId) => { dispatched.push(agentId); },
      stopTask: (agentId, cause) => { stops.push([agentId, cause]); },
      ended: new Promise(() => {}), served: false, close: async () => {},
    };
    const ownRequests: Parameters<AnthropicOperations["createStream"]>[0][] = [];
    const own: AnthropicOperations = {
      createStream: async (params) => {
        ownRequests.push(params);
        return { data: Object.assign((async function* () {})(), { controller: new AbortController() }), response: new Response(null) };
      },
      isBadRequestError: () => false,
    };
    const projectRoot = directory("hosted-project-");
    const config: HostedAgentConfig = {
      registry: { lease: () => ({ host, opened: true, release: async () => { releases += 1; } }), drain: async () => {} }, launchHost: unused, configDir: folder.configDir, tree: TREE, login: "login", projectRoot,
      wireModelId: MODEL, contextLimit: 200_000, lineup: () => [], recordModelRefusal: () => {}, markQuotaExhausted: unused, extraUsage: "refuse", reportsExtraUsage: () => false,
      accountEmail: () => undefined, engineShell: () => undefined, onExtraUsageStop: () => {}, recordUsage: () => {}, recordOutcome: () => {}, ownEngine: async () => own,
      silentVersions: silentVersions(),
    };
    const agent = createHostedAgent(config);
    const entries = createHostedAgentEntries(() => true);
    const history: ConversationMessage[] = [{ kind: "user", origin: "human", content: "Find the value." }];
    /** Sends the next request as the agent loop does: the route's entries when a host serves it, then the request
     *  that the adapter prepares, with the host's answer read to its end. */
    const send = async (effort: StreamOptions["reasoningEffort"], conversation: string) => {
      const options = (): StreamOptions => ({ messages: [...history], tools: [LOOKUP], systemPrompt: { stable: "You review one claim.", session: "", conversation }, reasoningEffort: effort });
      const prepared = () => prepareAnthropicRequest({ accessProvider: "claude_agent_sdk", model: MODEL, wireModel: MODEL, info, contextLimit: 200_000, options: options(), presentation: MCP_TOOLS, hosted: true });
      if (prepared().historyTarget.sharedHost) history.push(...entries(options()));
      const { params, historyTarget, origins } = prepared();
      const { data } = await agent.operations.createStream(params, { sharedHost: historyTarget.sharedHost, origins, signal: new AbortController().signal, headers: {} });
      for await (const _ of data) { /* the bridge parks or settles the agent at the stream's end */ }
      return params;
    };

    await send("low", tiers[0]!);
    const [first] = dispatched;
    if (first === undefined) throw new Error("the first request dispatched no agent");
    expect(existsSync(agentFilePath(folder, first))).toBe(true);
    history.push(
      { kind: "assistant", accessProvider: "claude_agent_sdk", provider: "anthropic", api: "anthropic-messages", model: MODEL, content: [{ type: "tool_use", id: "toolu_1", name: "lookup", input: { key: "k" } }] },
      { kind: "toolResult", toolUseId: "toolu_1", content: [{ type: "text", text: "VALUE" }] },
    );

    // The person turns thinking off, which the host's engine cannot serve, and the agent's conversation tier changed.
    await send("off", tiers[1]!);
    expect(stops).toEqual([[first, "own-engine"]]);
    expect(existsSync(agentFilePath(folder, first))).toBe(false);
    expect(releases).toBe(1);
    expect(ownRequests).toHaveLength(1);
    const ownMessages = JSON.stringify(ownRequests[0]?.messages);
    for (const framing of [ENGINE_INSTRUCTIONS, DISPATCH_TEXT, ...tiers.map(conversationTierEntry)]) expect(ownMessages).not.toContain(JSON.stringify(framing).slice(1, -1));
    expect(ownMessages).toContain("VALUE");
    const ownSystem = JSON.stringify(ownRequests[0]?.system);
    expect(ownSystem.split(JSON.stringify(tiers[1]).slice(1, -1))).toHaveLength(2);
    expect(ownSystem).not.toContain(JSON.stringify(tiers[0]).slice(1, -1));

    history.push({ kind: "assistant", accessProvider: "claude_agent_sdk", provider: "anthropic", api: "anthropic-messages", model: MODEL, content: [{ type: "text", text: "The value is VALUE." }] }, { kind: "user", origin: "human", content: "Say it again." });
    await send("low", tiers[1]!);
    expect(dispatched).toHaveLength(2);
    expect(dispatched[1]).not.toBe(first);
    expect(ownRequests).toHaveLength(1);
  });
});
