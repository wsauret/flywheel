import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_HOST_SOCKET_VARIABLE, createHostGate, serveHostGate, type AgentStepSink, type HostStepItem, type RefusedHostStep } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/host-gate.js";

/** The host plugin's hook module source, which each host's copy holds byte for byte. */
const HOOK_SOURCE = join(import.meta.dir, "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/host-plugin/hooks/register.js.txt");

function recordingSink() {
  const items: HostStepItem[] = [];
  let done = 0;
  const sink: AgentStepSink = { item: (item) => items.push(item), done: () => { done += 1; } };
  return { sink, items, done: () => done };
}

const REQUEST_FAILURE = new Error("404 status code (no body)");

/** A model request that fails before its first chunk.
 *  @yields {unknown} Nothing: the request fails first. */
async function* failingRequest(): AsyncGenerator<unknown, unknown> {
  yield* [];
  throw REQUEST_FAILURE;
}

/** A gate whose host records what the gate tells it. `settled` answers each step's settlement, at once unless a test
 *  holds it. */
function gate(settled: () => Promise<boolean> = async () => true) {
  const refused: RefusedHostStep[] = [];
  const advanced: string[] = [];
  const asked: string[] = [];
  const admitted: string[] = [];
  return {
    refused, advanced, asked, admitted,
    gate: createHostGate({
      dispatcherValues: () => ({ effort: "low" }), dispatcherAdvanced: (nonce) => { advanced.push(nonce); }, dispatcherAsked: (nonce) => { asked.push(nonce); },
      agentAdmitted: (agentId) => { admitted.push(agentId); }, refused: (step) => { refused.push(step); }, settled,
    }),
  };
}

describe("the host gate", () => {
  test("admits steps 0 and 1 of a turn whose start text holds a pushed nonce, at the dispatcher's effort, tells the host of the turn's open and each admitted step, and refuses every other main-thread step", async () => {
    const { gate: host, refused, advanced } = gate();
    const nonce = host.nonce();
    expect(await host.serve("/step", { turnId: "notice", index: 0, messageCount: 1, agentId: null })).toEqual({ admit: false });
    host.serve("/turn", { turnId: "frame", text: `${nonce}\nagents: a1` });
    expect(await host.serve("/step", { turnId: "frame", index: 0, messageCount: 1, agentId: null })).toEqual({ admit: true, effort: "low" });
    expect(await host.serve("/step", { turnId: "frame", index: 1, messageCount: 3, agentId: null })).toEqual({ admit: true, effort: "low" });
    expect(await host.serve("/step", { turnId: "frame", index: 2, messageCount: 5, agentId: null })).toEqual({ admit: false });
    expect(host.dispatcherSteps(nonce)).toBe(2);
    // A nonce opens one turn only.
    host.serve("/turn", { turnId: "replay", text: nonce });
    expect(await host.serve("/step", { turnId: "replay", index: 0, messageCount: 1, agentId: null })).toEqual({ admit: false });
    expect(refused.map(({ turnId, index }) => `${turnId}:${index}`)).toEqual(["notice:0", "frame:2", "replay:0"]);
    expect(advanced).toEqual([nonce, nonce, nonce]);
  });

  test("a retired frame's turn and steps are forgotten: its later steps are refused, and a retired nonce that opened no turn opens none", async () => {
    const { gate: host, refused, advanced } = gate();
    const opened = host.nonce();
    host.serve("/turn", { turnId: "frame", text: opened });
    await host.serve("/step", { turnId: "frame", index: 0, messageCount: 1, agentId: null });
    host.retire(opened);
    expect(host.dispatcherSteps(opened)).toBe(0);
    expect(await host.serve("/step", { turnId: "frame", index: 1, messageCount: 3, agentId: null })).toEqual({ admit: false });
    // The frame of a nonce that the engine never opened ends too.
    const unopened = host.nonce();
    host.retire(unopened);
    host.serve("/turn", { turnId: "late", text: unopened });
    expect(await host.serve("/step", { turnId: "late", index: 0, messageCount: 1, agentId: null })).toEqual({ admit: false });
    expect(refused.map(({ turnId, index }) => `${turnId}:${index}`)).toEqual(["frame:1", "late:0"]);
    expect(advanced).toEqual([opened, opened]);
  });

  test("a call denied in a dispatch turn's step admits the one step that answers the denial, and a dispatcher that repeats the denied call gets no step past 2", async () => {
    const { gate: host, refused } = gate();
    const nonce = host.nonce();
    host.serve("/turn", { turnId: "frame", text: `${nonce}\nagents: a1` });
    await host.serve("/step", { turnId: "frame", index: 0, messageCount: 1, agentId: null });
    // A denial in step 0 needs no more than the step 1 that every dispatch turn has.
    host.denied(nonce);
    expect(await host.serve("/step", { turnId: "frame", index: 1, messageCount: 3, agentId: null })).toEqual({ admit: true, effort: "low" });
    host.denied(nonce);
    expect(await host.serve("/step", { turnId: "frame", index: 2, messageCount: 5, agentId: null })).toEqual({ admit: true, effort: "low" });
    host.denied(nonce);
    expect(await host.serve("/step", { turnId: "frame", index: 3, messageCount: 7, agentId: null })).toEqual({ admit: false });
    expect(host.dispatcherSteps(nonce)).toBe(3);
    expect(refused.map(({ turnId, index }) => `${turnId}:${index}`)).toEqual(["frame:3"]);
  });

  test("admits an agent's step once with its effort, hands its chunks to its sink in order, and refuses a step it did not admit", async () => {
    const { gate: host } = gate();
    const recorded = recordingSink();
    expect(await host.serve("/step", { turnId: "t", index: 0, messageCount: 1, agentId: "a1" })).toEqual({ admit: false });
    host.admit("a1", { effort: "high" }, recorded.sink);
    expect(await host.serve("/step", { turnId: "t", index: 0, messageCount: 1, agentId: "a1" })).toEqual({ admit: true, effort: "high" });
    host.serve("/item", { agentId: "a1", item: { kind: "thinking", index: 0, text: "T" } });
    host.serve("/item", { agentId: "a1", item: { kind: "tool", index: 1, id: "toolu_1", name: "mcp__runtime__read" } });
    host.serve("/item", { agentId: "a1", item: { kind: "stop", stopReason: "tool_use", usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 } } });
    host.serve("/done", { agentId: "a1" });
    expect(recorded.items).toEqual([
      { kind: "thinking", index: 0, text: "T" },
      { kind: "tool", index: 1, id: "toolu_1", name: "mcp__runtime__read" },
      { kind: "stop", stopReason: "tool_use", usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 } },
    ]);
    expect(recorded.done()).toBe(1);
    // The admission served its one step; the engine's own next step is refused.
    expect(await host.serve("/step", { turnId: "t", index: 1, messageCount: 3, agentId: "a1" })).toEqual({ admit: false });
  });

  test("an admitted step tells the host which agent sends, and a closed admission or gate admits nothing more", async () => {
    const { gate: host, admitted } = gate();
    const recorded = recordingSink();
    host.admit("a1", {}, recorded.sink);
    expect(await host.serve("/step", { turnId: "t", index: 0, messageCount: 1, agentId: "a1" })).toEqual({ admit: true });
    expect(admitted).toEqual(["a1"]);
    host.admit("a2", {}, recordingSink().sink).close();
    expect(await host.serve("/step", { turnId: "u", index: 0, messageCount: 1, agentId: "a2" })).toEqual({ admit: false });
    host.admit("a3", {}, recordingSink().sink);
    host.close();
    expect(await host.serve("/step", { turnId: "v", index: 0, messageCount: 1, agentId: "a3" })).toEqual({ admit: false });
  });

  test("every step that the gate can admit waits for the host's settlement: a dispatcher continuation first tells the host that it asks, and a step whose settlement stops the account is refused", async () => {
    const settlement = Promise.withResolvers<boolean>();
    const { gate: host, asked, advanced, admitted, refused } = gate(() => settlement.promise);
    const nonce = host.nonce();
    await host.serve("/turn", { turnId: "frame", text: nonce });
    const step = host.serve("/step", { turnId: "frame", index: 0, messageCount: 1, agentId: null });
    host.admit("a1", {}, recordingSink().sink);
    const agentStep = host.serve("/step", { turnId: "t", index: 0, messageCount: 1, agentId: "a1" });
    // Neither step is admitted while the settlement runs.
    expect(asked).toEqual([nonce]);
    expect(advanced).toEqual([nonce]);
    expect(host.dispatcherSteps(nonce)).toBe(0);
    settlement.resolve(false);

    expect(await step).toEqual({ admit: false });
    expect(await agentStep).toEqual({ admit: false });
    expect(admitted).toEqual([]);
    expect(refused.map(({ turnId, index }) => `${turnId}:${index}`)).toEqual(["frame:0", "t:0"]);
  });

  test("the host's plugin copy holds the hook source byte for byte, and a hosted step whose request fails passes the failure on and asks the gate nothing more, because the engine's debug output states the service's answer", async () => {
    const paths: string[] = [];
    const { gate: host } = gate();
    host.admit("a1", {}, recordingSink().sink);
    const server = serveHostGate({ serve: (path, body) => { paths.push(path); return host.serve(path, body); } });
    try {
      expect(readFileSync(join(server.pluginPath, "hooks/register.js"), "utf8")).toBe(readFileSync(HOOK_SOURCE, "utf8"));
      type Handler = ($: unknown, e: { readonly turnId: string; readonly index: number; readonly messageCount: number; readonly agentId: string }, send: (step: unknown) => AsyncGenerator<unknown, unknown>) => AsyncGenerator<unknown, unknown>;
      const hooks = new Map<string, Handler>();
      const plugin: { register(on: (event: string, handler: Handler) => { catch(handler: Handler): void }): void } = await import(join(server.pluginPath, "hooks/register.js"));
      plugin.register((event, handler) => {
        hooks.set(event, handler);
        return { catch: () => {} };
      });
      const $ = {
        env: { get: async (name: string) => name === AGENT_HOST_SOCKET_VARIABLE ? server.socketPath : undefined },
        http: {
          fetch: async (url: string, init: { readonly method: string; readonly socketPath: string; readonly body: string }) => {
            const response = await fetch(url, { method: init.method, unix: init.socketPath, body: init.body });
            return { ok: response.ok, text: await response.text() };
          },
        },
      };
      const step = hooks.get("turn.step")?.($, { turnId: "t", index: 0, messageCount: 1, agentId: "a1" }, failingRequest);
      await expect(step?.next() ?? Promise.resolve()).rejects.toBe(REQUEST_FAILURE);
      expect(paths).toEqual(["/step"]);
    } finally {
      server.close();
    }
  });
});
