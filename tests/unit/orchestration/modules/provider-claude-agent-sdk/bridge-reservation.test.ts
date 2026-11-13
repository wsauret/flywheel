import { describe, expect, test } from "bun:test";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { DebugLog } from "../../../../../src/infra/debug-log.js";
import { Scope } from "effect";
import type { ProviderDemand } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { releaseLiveBridges } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/live-bridges.js";
import { originsOf, A2, answers, cliInit, forwardDiagnostics, init, payloads, request, send, settle, turnDone, U1, U1_WITH_ENVIRONMENT, U2, until, withBridge } from "./_bridge-harness.js";

forwardDiagnostics();

/** Runs `body` with the DEBUG families written. */
async function verbose(body: () => Promise<void>): Promise<void> {
  DebugLog.setVerbose(true);
  try {
    await body();
  } finally {
    DebugLog.setVerbose(false);
  }
}

/** The message that a session's owner sends in place of the person's next one when it anticipates the send. */
const PLACEHOLDER: MessageParam = { role: "user", content: [{ type: "text", text: "(next message)" }] };

describe("the bridge's anticipated engines", () => {
  const reserved = () => payloads("provider.claude_sdk.engine.reserved");
  const ended = () => payloads("provider.claude_sdk.engine.reservation_ended");

  test("an anticipated first request starts its engine before it comes, and then takes that engine without a second start", () => withBridge(async (harness) => {
    expect(await harness.ops.anticipate?.(request([U1]), { origins: originsOf(request([U1])), sharedHost: false })).toBeDefined();
    expect(reserved()).toHaveLength(1);
    const engine = harness.queries[0];
    expect(harness.queries).toHaveLength(1);
    expect(engine?.pushed).toEqual([]);
    expect(engine?.launch.session).toMatchObject({ kind: "fresh" });

    const first = await send(harness.ops, request([U1]));
    await until(() => harness.log.at(-1) === "push");
    engine?.emit(init, ...answers("Done."));
    expect(await first.error).toBeUndefined();
    expect(harness.queries).toHaveLength(1);
    expect(reserved()).toEqual([expect.objectContaining({ sessionId: engine?.launch.session.id, historyMessages: 0 })]);
    expect(payloads("provider.claude_sdk.query.started")).toEqual([expect.objectContaining({ sessionId: engine?.launch.session.id, engine: "reserved", reservedMs: expect.any(Number) })]);
    expect(ended()).toEqual([]);
  }));

  test("an engine anticipated for a conversation with history resumes its transcript, and the next message of that conversation takes it with one push", () => withBridge(async (harness) => {
    harness.ops.anticipate?.(request([U1, A2, PLACEHOLDER]), { origins: originsOf(request([U1, A2, PLACEHOLDER])), sharedHost: false });
    await until(() => reserved().length === 1);
    const engine = harness.queries[0];
    expect(engine?.launch.session).toMatchObject({ kind: "resume" });
    expect(engine?.pushed).toEqual([]);
    expect(reserved()).toEqual([expect.objectContaining({ historyMessages: 2 })]);

    const next = await send(harness.ops, request([U1, A2, U2]));
    await until(() => engine?.pushed.length === 1);
    expect(engine?.pushed[0]).toMatchObject({ message: { role: "user", content: U2.content } });
    engine?.emit(init, ...answers("Next."));
    expect(await next.error).toBeUndefined();
    expect(harness.queries).toHaveLength(1);
    expect(ended()).toEqual([]);
  }));

  test("a request whose history differs from the anticipated one never reads the reserved transcript: the reservation ends and the request starts its own engine", () => withBridge(async (harness) => {
    harness.ops.anticipate?.(request([U1, A2, PLACEHOLDER]), { origins: originsOf(request([U1, A2, PLACEHOLDER])), sharedHost: false });
    await until(() => reserved().length === 1);
    const edited: MessageParam = { role: "user", content: [{ type: "text", text: "Read b." }] };

    const next = await send(harness.ops, request([edited, A2, U2]));
    await until(() => harness.queries[1]?.pushed.length === 1);
    harness.queries[1]?.emit(init, ...answers("Next."));
    expect(await next.error).toBeUndefined();
    await until(() => harness.queries[0]?.exited === true);
    expect(harness.queries[0]?.pushed).toEqual([]);
    expect(ended()).toEqual([expect.objectContaining({ rule: "unmatched", field: "history" })]);
    // The reservation's transcript, of the history that the request did not send, left with it.
    expect([...harness.files.values()].filter((rows) => rows.includes("Read a."))).toEqual([]);
  }));

  test("a request whose history reminders differ from the anticipated ones starts its own engine", () => withBridge(async (harness) => {
    harness.ops.anticipate?.(request([U1, A2, PLACEHOLDER]), { origins: originsOf(request([U1, A2, PLACEHOLDER])), sharedHost: false });
    await until(() => reserved().length === 1);

    const next = await send(harness.ops, request([U1_WITH_ENVIRONMENT, A2, U2]));
    await until(() => harness.queries[1]?.pushed.length === 1);
    harness.queries[1]?.emit(init, ...answers("Next."));
    expect(await next.error).toBeUndefined();
    await until(() => harness.queries[0]?.exited === true);
    expect(harness.queries[0]?.pushed).toEqual([]);
    expect(ended()).toEqual([expect.objectContaining({ rule: "unmatched", field: "reminders" })]);
  }));

  test("releasing the only claim on a reservation stops its engine, and a later request starts its own", () => withBridge(async (harness) => {
    const claim = await harness.ops.anticipate?.(request([U1]), { origins: originsOf(request([U1])), sharedHost: false });
    await claim?.release();
    await until(() => harness.queries[0]?.exited === true);
    expect(harness.queries[0]?.pushed).toEqual([]);
    expect(ended()).toEqual([expect.objectContaining({ rule: "released" })]);

    const first = await send(harness.ops, request([U1]));
    await until(() => harness.queries[1]?.pushed.length === 1);
    harness.queries[1]?.emit(init, ...answers("Done."));
    expect(await first.error).toBeUndefined();
  }));

  test("a release of a claim whose reservation a request took does nothing to the engine", () => withBridge(async (harness) => {
    const claim = await harness.ops.anticipate?.(request([U1]), { origins: originsOf(request([U1])), sharedHost: false });
    const first = await send(harness.ops, request([U1]));
    await until(() => harness.queries[0]?.pushed.length === 1);
    harness.queries[0]?.emit(init, ...answers("Done."), turnDone);
    expect(await first.error).toBeUndefined();
    await claim?.release();
    await settle();
    expect(harness.queries[0]?.exited).toBe(false);
    expect(ended()).toEqual([]);
  }));

  test("a reserved engine waits for its request for as long as the bridge lives", () => withBridge(async (harness) => {
    harness.ops.anticipate?.(request([U1]), { origins: originsOf(request([U1])), sharedHost: false });
    await until(() => reserved().length === 1);
    await harness.advance(60 * 60_000);
    await settle();
    expect(harness.queries[0]?.exited).toBe(false);
    expect(ended()).toEqual([]);

    const first = await send(harness.ops, request([U1]));
    await until(() => harness.queries[0]?.pushed.length === 1);
    harness.queries[0]?.emit(init, ...answers("Done."));
    expect(await first.error).toBeUndefined();
    expect(harness.queries).toHaveLength(1);
  }));

  test("closing the bridge stops a reserved engine before the close ends", async () => {
    let engines: readonly { readonly exited: boolean }[] = [];
    await withBridge(async (harness) => {
      engines = harness.queries;
      harness.ops.anticipate?.(request([U1]), { origins: originsOf(request([U1])), sharedHost: false });
      await until(() => reserved().length === 1);
    });
    expect(engines.map(({ exited }) => exited)).toEqual([true]);
    expect(ended()).toEqual([expect.objectContaining({ rule: "bridge-closed" })]);
  });

  test.each([
    ["a narrower window than the reserved engine's", 1_000_000, 200_000],
    ["a wider window than the reserved engine's", 200_000, 1_000_000],
  ] as const)("a request admitted for %s stops the reserved engine and starts its own at the request's window", (_name, reservedWindow, requestWindow) => withBridge(async (harness) => {
    harness.opsFor({ contextLimit: reservedWindow, eligibilityRevision: 1 }).anticipate?.(request([U1]), { origins: originsOf(request([U1])), sharedHost: false });
    await until(() => reserved().length === 1);

    const first = await send(harness.opsFor({ contextLimit: requestWindow, eligibilityRevision: 2 }), request([U1]));
    await until(() => harness.queries[1]?.pushed.length === 1);
    harness.queries[1]?.emit(init, ...answers("Done."));
    expect(await first.error).toBeUndefined();
    await until(() => harness.queries[0]?.exited === true);
    expect(harness.queries.map(({ launch }) => launch.contextLimit)).toEqual([reservedWindow, requestWindow]);
    expect(ended()).toEqual([expect.objectContaining({ rule: "unmatched", field: "context-limit" })]);
  }));

  test("a request whose launch values differ from the anticipated ones stops the reserved engine and starts its own", () => withBridge(async (harness) => {
    harness.ops.anticipate?.(request([U1]), { origins: originsOf(request([U1])), sharedHost: false });
    await until(() => reserved().length === 1);

    const first = await send(harness.ops, request([U1], { output_config: { effort: "high" } }));
    await until(() => harness.queries[1]?.pushed.length === 1);
    harness.queries[1]?.emit(init, ...answers("Done."));
    expect(await first.error).toBeUndefined();
    await until(() => harness.queries[0]?.exited === true);
    expect(harness.queries[0]?.pushed).toEqual([]);
    expect(ended()).toEqual([expect.objectContaining({ rule: "unmatched", field: "effort" })]);
  }));

  test("an anticipation that the reservation matches renews it with a claim of its own, so the release of the older claim keeps the engine; one that differs replaces it", () => withBridge(async (harness) => {
    const older = await harness.ops.anticipate?.(request([U1]), { origins: originsOf(request([U1])), sharedHost: false });
    const renewed = await harness.ops.anticipate?.(request([U1]), { origins: originsOf(request([U1])), sharedHost: false });
    expect(renewed).toBeDefined();
    expect(renewed).not.toBe(older);
    await older?.release();
    await settle();
    expect({ engines: harness.queries.length, exited: harness.queries[0]?.exited, ended: ended() }).toEqual({ engines: 1, exited: false, ended: [] });

    expect(await harness.ops.anticipate?.(request([U1], { output_config: { effort: "high" } }), { origins: originsOf(request([U1], { output_config: { effort: "high" } })), sharedHost: false })).toBeDefined();
    expect(reserved()).toHaveLength(2);
    await until(() => harness.queries[0]?.exited === true);
    expect(ended()).toEqual([expect.objectContaining({ rule: "replaced", field: "effort" })]);
    // The claim on the replaced reservation holds nothing now.
    await renewed?.release();
    await settle();
    expect(harness.queries[1]?.exited).toBe(false);

    const first = await send(harness.ops, request([U1], { output_config: { effort: "high" } }));
    await until(() => harness.queries[1]?.pushed.length === 1);
    harness.queries[1]?.emit(init, ...answers("Done."));
    expect(await first.error).toBeUndefined();
    expect(harness.queries).toHaveLength(2);
    expect(ended()).toHaveLength(1);
  }));

  // A skipped reservation is a DEBUG family, which the debug level writes.
  test("an anticipated request that the planner refuses starts no engine and records why", () => verbose(() => withBridge(async (harness) => {
    expect(await harness.ops.anticipate?.(request([U1, A2]), { origins: originsOf(request([U1, A2])), sharedHost: false })).toBeUndefined();
    expect(harness.queries).toEqual([]);
    expect(reserved()).toEqual([]);
    expect(payloads("provider.claude_sdk.engine.reservation_skipped")).toEqual([
      expect.objectContaining({ reason: "not-started", plan: "refuse", issue: "the request ends with an assistant message" }),
    ]);
  })));

  test("an anticipated request whose engine cannot start reserves nothing and records the failure's kind", () => verbose(() => withBridge(async (harness) => {
    expect(await harness.ops.anticipate?.(request([U1]), { origins: originsOf(request([U1])), sharedHost: false })).toBeUndefined();
    expect(reserved()).toEqual([]);
    expect(payloads("provider.claude_sdk.engine.reservation_skipped")).toEqual([expect.objectContaining({ reason: "start-failed", error: "Error" })]);
  }, { launchesBeforeFailure: 0 })));

  test("a request anticipated while a query is live reserves nothing and claims the live engine, which a busy request holds and the release of the last claim stops once it rests idle", () => withBridge(async (harness) => {
    const first = await send(harness.ops, request([U1]));
    harness.queries[0]?.emit(init, ...answers("Done."), turnDone);
    expect(await first.error).toBeUndefined();

    const anticipated = () => harness.ops.anticipate?.(request([U1, A2, PLACEHOLDER]), { origins: originsOf(request([U1, A2, PLACEHOLDER])), sharedHost: false });
    const older = await anticipated();
    const renewed = await anticipated();
    expect(older).toBeDefined();
    expect(renewed).not.toBe(older);
    expect(harness.queries).toHaveLength(1);
    expect(reserved()).toEqual([]);

    const next = await send(harness.ops, request([U1, A2, U2]));
    await until(() => harness.queries[0]?.pushed.length === 2);
    await older?.release();
    await renewed?.release();
    await settle();
    expect(harness.queries[0]?.exited).toBe(false);
    harness.queries[0]?.emit(...answers("Next."), turnDone);
    expect(await next.error).toBeUndefined();
    await settle();
    expect(harness.queries[0]?.exited).toBe(false);

    const last = await anticipated();
    await last?.release();
    await until(() => harness.queries[0]?.exited === true);
    expect(payloads("provider.claude_sdk.query.stopped")).toEqual([expect.objectContaining({ reason: "release", rule: "released", phase: "idle" })]);
  }));

  test("a reserved engine that ends ends its reservation and removes its transcript, and the next anticipation starts a new engine", () => withBridge(async (harness) => {
    expect(await harness.ops.anticipate?.(request([U1, A2, PLACEHOLDER]), { origins: originsOf(request([U1, A2, PLACEHOLDER])), sharedHost: false })).toBeDefined();
    expect(harness.files.size).toBe(1);
    harness.queries[0]?.end();
    await until(() => ended().length === 1);
    expect(ended()).toEqual([expect.objectContaining({ rule: "engine-ended" })]);
    expect(harness.files.size).toBe(0);

    expect(await harness.ops.anticipate?.(request([U1, A2, PLACEHOLDER]), { origins: originsOf(request([U1, A2, PLACEHOLDER])), sharedHost: false })).toBeDefined();
    expect(harness.queries).toHaveLength(2);
    const next = await send(harness.ops, request([U1, A2, U2]));
    await until(() => harness.queries[1]?.pushed.length === 1);
    harness.queries[1]?.emit(init, ...answers("Next."));
    expect(await next.error).toBeUndefined();
    expect(harness.queries[0]?.pushed).toEqual([]);
    expect(payloads("provider.claude_sdk.query.started")).toEqual([expect.objectContaining({ engine: "reserved", sessionId: harness.queries[1]?.launch.session.id })]);
  }));

  test("the query that takes a reserved engine reads what the engine said while reserved, in order", async () => {
    await withBridge(async (harness) => {
      await harness.ops.anticipate?.(request([U1]), { origins: originsOf(request([U1])), sharedHost: false });
      harness.queries[0]?.emit(cliInit({ claude_code_version: "2.1.294" }), cliInit({ claude_code_version: "2.1.295" }));
      await settle();
      const first = await send(harness.ops, request([U1]));
      await until(() => harness.queries[0]?.pushed.length === 1);
      harness.queries[0]?.emit(...answers("Done."));
      expect(await first.error).toBeUndefined();
    });
    expect(payloads("provider.claude_sdk.query.stopped")).toEqual([expect.objectContaining({ cliVersion: "2.1.295" })]);
  });

  test("a replaced reservation removes its transcript", () => withBridge(async (harness) => {
    await harness.ops.anticipate?.(request([U1, A2, PLACEHOLDER]), { origins: originsOf(request([U1, A2, PLACEHOLDER])), sharedHost: false });
    expect(harness.files.size).toBe(1);
    const first = [...harness.files.keys()];
    await harness.ops.anticipate?.(request([U1, A2, PLACEHOLDER], { output_config: { effort: "high" } }), { origins: originsOf(request([U1, A2, PLACEHOLDER], { output_config: { effort: "high" } })), sharedHost: false });
    await until(() => harness.queries[0]?.exited === true);
    expect(ended()).toEqual([expect.objectContaining({ rule: "replaced" })]);
    expect(harness.files.size).toBe(1);
    expect(first.some((path) => harness.files.has(path))).toBe(false);
    await harness.ops.anticipate?.(request([U1, A2, PLACEHOLDER]), { origins: originsOf(request([U1, A2, PLACEHOLDER])), sharedHost: false });
    await until(() => harness.queries[1]?.exited === true);
    expect(harness.files.size).toBe(1);
  }));
});

describe("the session's engine ends, as the bridge reports them to the session's demand", () => {
  /** A session's demand that counts each ask to plan again. */
  const watch = () => {
    let stale = 0;
    const demand: ProviderDemand = { scope: Scope.makeUnsafe("sequential"), stale: () => { stale += 1; } };
    return { demand, stale: () => stale };
  };

  test("an engine that served and then exits by itself asks the session to plan again once", () => {
    const owner = watch();
    return withBridge(async (harness) => {
      const first = await send(harness.ops, request([U1]));
      harness.queries[0]?.emit(init, ...answers("Done."), turnDone);
      expect(await first.error).toBeUndefined();
      harness.queries[0]?.end();
      await until(() => harness.queries[0]?.exited === true);
      await settle();
      expect(owner.stale()).toBe(1);
    }, { demand: owner.demand });
  });

  test("turning the module off drains a reserved engine and asks the session to plan again once", () => {
    const owner = watch();
    return withBridge(async (harness) => {
      await harness.ops.anticipate?.(request([U1]), { origins: originsOf(request([U1])), sharedHost: false });
      releaseLiveBridges();
      await until(() => harness.queries[0]?.exited === true);
      expect(payloads("provider.claude_sdk.engine.reservation_ended")).toEqual([expect.objectContaining({ rule: "module-off" })]);
      expect(owner.stale()).toBe(1);
    }, { demand: owner.demand });
  });

  test("the release of the session's last claim on its idle engine asks for no plan", () => {
    const owner = watch();
    return withBridge(async (harness) => {
      const first = await send(harness.ops, request([U1]));
      harness.queries[0]?.emit(init, ...answers("Done."), turnDone);
      expect(await first.error).toBeUndefined();
      const claim = await harness.ops.anticipate?.(request([U1, A2, PLACEHOLDER]), { origins: originsOf(request([U1, A2, PLACEHOLDER])), sharedHost: false });
      await claim?.release();
      await until(() => harness.queries[0]?.exited === true);
      expect(owner.stale()).toBe(0);
    }, { demand: owner.demand });
  });

  test("a reserved engine that ends before it served, the engine's rotation, and the bridge's close ask for no plan", async () => {
    const owner = watch();
    await withBridge(async (harness) => {
      await harness.ops.anticipate?.(request([U1, A2, PLACEHOLDER]), { origins: originsOf(request([U1, A2, PLACEHOLDER])), sharedHost: false });
      harness.queries[0]?.end();
      await until(() => payloads("provider.claude_sdk.engine.reservation_ended").length === 1);
      const first = await send(harness.ops, request([U1]));
      await until(() => harness.queries[1]?.pushed.length === 1);
      harness.queries[1]?.emit(init, ...answers("Done."), turnDone);
      expect(await first.error).toBeUndefined();
      const rotated = await send(harness.ops, request([U1, A2, U2], { output_config: { effort: "high" } }));
      await until(() => harness.queries[2]?.pushed.length === 1);
      harness.queries[2]?.emit(init, ...answers("Next."), turnDone);
      expect(await rotated.error).toBeUndefined();
    }, { demand: owner.demand });
    expect(owner.stale()).toBe(0);
  });
});
