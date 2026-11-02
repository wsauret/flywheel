import { describe, expect, test } from "bun:test";
import type { AccessProviderId } from "../../../../../src/infra/llm/access-provider.js";
import type { ProviderAvailability, QuotaStanding, RecheckPending } from "../../../../../src/orchestration/agent-runtime/llm/provider-availability-types.js";
import { chain, executeStream, fakeAvailability, fakeClient, preparedRequest, singletonCandidate, streamOptions, textDelta, textStream } from "./_provider-chain-harness.js";

const pending = (revision = 1): RecheckPending => ({ kind: "recheck_pending", revision, untilMs: Date.now() + 30_000 });

function controlledAvailability(initial: Readonly<{ [provider: string]: QuotaStanding }>) {
  const base = fakeAvailability({}).availability;
  const standings = new Map<string, QuotaStanding>(Object.entries(initial));
  const waits: RecheckPending[] = [];
  let claims = 0;
  let releases = 0;
  const gate = Promise.withResolvers<void>();
  const availability: ProviderAvailability = {
    ...base,
    genericQuotaStanding: (candidate) => standings.get(candidate.providerId) ?? { kind: "live" },
    chatGptStanding: (candidate) => standings.get(candidate.providerId) ?? { kind: "live" },
    claimQuotaProbe: () => { claims += 1; return undefined; },
    releaseQuotaProbe: () => { releases += 1; },
    waitForChange: async (value, signal) => {
      waits.push(value);
      await Promise.race([
        gate.promise,
        new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
      ]);
    },
  };
  return {
    availability,
    waits,
    get claims() { return claims; },
    get releases() { return releases; },
    set(provider: AccessProviderId, standing: QuotaStanding) { standings.set(provider, standing); },
    releaseWait() { gate.resolve(); },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("pending provider coordination", () => {
  test("an admitted run waits and serves a candidate that becomes ready later", async () => {
    const controlled = controlledAvailability({ chatgpt: pending() });
    const request = await chain({ availability: controlled.availability, candidates: ["chatgpt"] }).admitRequest();
    const running = request.run({ prepare: preparedRequest, execute: async ({ attempt }) => ({ kind: "success", value: attempt.accessProvider }) });
    await flush();
    controlled.set("chatgpt", { kind: "live" });
    controlled.releaseWait();
    expect(await running).toBe("chatgpt");
  });
  test("scans every candidate and serves a ready fallback without waiting", async () => {
    const state = controlledAvailability({ chatgpt: pending() });
    let prepares = 0;
    const client = chain({
      candidates: [singletonCandidate("chatgpt"), singletonCandidate("openai_api")],
      availability: state.availability,
    });

    const events = await (await client.admitRequest()).run({
      prepare: preparedRequest,
      execute: async ({ client: adapter }) => { prepares += 1; return executeStream(adapter, streamOptions); },
    });

    expect(events).toEqual([textDelta("openai_api")]);
    expect(state.waits).toEqual([]);
    expect(prepares).toBe(1);
    expect(state.claims).toBe(0);
    expect(state.releases).toBe(0);
  });

  test("waits before preparation, then rescans the same immutable chain", async () => {
    const state = controlledAvailability({ openai_api: pending(7) });
    let prepares = 0;
    let wires = 0;
    const client = chain({
      candidates: [singletonCandidate("openai_api")],
      availability: state.availability,
      build: async (provider) => fakeClient(provider, async function* () { wires += 1; yield textDelta(provider); }),
    });

    const running = (await client.admitRequest()).run({
      prepare: preparedRequest,
      execute: async ({ client: adapter }) => { prepares += 1; return executeStream(adapter, streamOptions); },
    });
    await flush();

    expect(state.waits).toHaveLength(1);
    expect(prepares).toBe(0);
    expect(wires).toBe(0);
    state.set("openai_api", { kind: "live" });
    state.releaseWait();

    expect(await running).toEqual([textDelta("openai_api")]);
    expect(prepares).toBe(1);
    expect(wires).toBe(1);
  });

  test("aborting a wait does not prepare, dispatch, claim, or release", async () => {
    const state = controlledAvailability({ openai_api: pending() });
    const abort = new AbortController();
    let prepares = 0;
    let builds = 0;
    const client = chain({
      candidates: [singletonCandidate("openai_api")],
      availability: state.availability,
      build: async (provider) => { builds += 1; return fakeClient(provider, textStream(provider)); },
    });
    const running = (await client.admitRequest()).run({
      prepare: preparedRequest,
      signal: abort.signal,
      execute: async ({ client: adapter }) => { prepares += 1; return executeStream(adapter, streamOptions); },
    });
    await flush();
    abort.abort(new DOMException("stopped", "AbortError"));

    await expect(running).rejects.toHaveProperty("name", "AbortError");
    expect(prepares).toBe(0);
    expect(builds).toBe(0);
    expect(state.claims).toBe(0);
    expect(state.releases).toBe(0);
  });

  test("a preparation waits on a pending recheck as a serve does, then connects the candidate whose recheck is due without claiming its lease or recording a routing choice", async () => {
    const state = controlledAvailability({ chatgpt: pending() });
    const routed: string[] = [];
    let wires = 0;
    const client = chain({
      candidates: [singletonCandidate("chatgpt")],
      availability: state.availability,
      routing: { record: (decision) => { routed.push(decision.kind); } },
      build: async (provider) => fakeClient(provider, async function* () { wires += 1; yield textDelta(provider); }),
    });
    const preparing = (await client.admitRequest()).prepare({ prepare: preparedRequest });
    await flush();
    expect(state.waits).toHaveLength(1);

    state.set("chatgpt", { kind: "probe_due" });
    state.releaseWait();
    const candidate = await preparing;

    expect(candidate.attempt.accessProvider).toBe("chatgpt");
    expect(candidate.prepared.attempt).toBe(candidate.attempt);
    expect(state.claims).toBe(0);
    expect(state.releases).toBe(0);
    expect(routed).toEqual([]);
    expect(wires).toBe(0);
  });

  test("a preparation stopped while its candidate connects rejects instead of returning the connected candidate", async () => {
    const state = controlledAvailability({});
    const abort = new AbortController();
    const client = chain({
      candidates: [singletonCandidate("openai_api")],
      availability: state.availability,
      build: async (provider) => {
        const connected = fakeClient(provider, textStream(provider));
        return { attempt: connected, connect: async () => { abort.abort(new DOMException("stopped", "AbortError")); return connected; } };
      },
    });

    await expect((await client.admitRequest()).prepare({ prepare: preparedRequest, signal: abort.signal })).rejects.toHaveProperty("name", "AbortError");
  });

  test("planning predicts the pending head without claiming or waiting", async () => {
    const state = controlledAvailability({ openai_api: pending() });
    const client = chain({ candidates: [singletonCandidate("openai_api")], availability: state.availability });

    expect((await client.plannedAttempt()).accessProvider).toBe("openai_api");
    expect(state.waits).toEqual([]);
    expect(state.claims).toBe(0);
    expect(state.releases).toBe(0);
  });
});
