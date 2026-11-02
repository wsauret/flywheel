import { describe, expect, test } from "bun:test";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Exit, Fiber, Queue, Scope } from "effect";
import { createBridgeRequests, type BridgeRequestInput } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/bridge-requests.js";
import { makeBridge } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/bridge.js";
import type { AnthropicOperations } from "../../../../../src/orchestration/agent-runtime/llm/anthropic.js";
import { LlmStreamError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { releaseLiveBridges } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/live-bridges.js";
import {
  A1, A2, admittedStart, answers, callHandler, forwardDiagnostics, init, messageStop, parked, payloads,
  R1, readsFile, records, request, send, settle, stopReason, text, U1, U2, until, withBridge, originsOf,
} from "./_bridge-harness.js";

forwardDiagnostics();
const temporaryDirectory = temporaryDirectories();

describe("bridge lifetime", () => {
  test("construction in a closed scope fails before accepting a request", () => withBridge(async ({ config }) => {
    const scope = Scope.makeUnsafe();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    const exit = await Effect.runPromiseExit(Scope.provide(scope)(makeBridge(config)));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(exit.cause).toMatchObject({ reasons: [{ _tag: "Fail", error: { kind: "transient" } }] });
  }));

  test("caller abort rejects createStream while its reply is pending", () => withBridge(async ({ ops }) => {
    const caller = new AbortController();
    const pending = ops.createStream(request([U1]), { origins: originsOf(request([U1])), sharedHost: true, signal: caller.signal, headers: {} });
    const stopped = new Error("caller stopped before admission");
    caller.abort(stopped);
    await expect(pending).rejects.toBe(stopped);
  }));

  test("worker exit rejects a pending reply even when the inbox accepted it", async () => {
    const inbox = await Effect.runPromise(Queue.unbounded<BridgeRequestInput>());
    const worker = Effect.runFork(Effect.never);
    const ops = createBridgeRequests((input) => Queue.offerUnsafe(inbox, input), worker);
    try {
      const pending = ops.createStream(request([U1]), { origins: originsOf(request([U1])), sharedHost: true, signal: new AbortController().signal, headers: {} });
      await Effect.runPromise(Fiber.interrupt(worker));
      await expect(pending).rejects.toMatchObject({ kind: "transient", message: "The Anthropic Subscription bridge closed" });
    } finally {
      await Effect.runPromise(Fiber.interrupt(worker));
      await Effect.runPromise(Queue.interrupt(inbox));
    }
  });

  test("an abort before the request ends interrupts the CLI and fails the read with the abort reason; a release after it ends does not", () => withBridge(async ({ ops, queries, log }) => {
    const settled = await send(ops, request([U1]));
    queries[0]?.emit(init, ...readsFile);
    await settled.read;
    settled.data.controller.abort();
    await settle();
    expect(log).toEqual(["push"]);
    const caller = new AbortController();
    const open = await send(ops, request([U1, A1, R1]), caller.signal);
    queries[0]?.emit(...admittedStart());
    await settle();
    const stall = new Error("stream stalled");
    caller.abort(stall);
    expect(await open.error).toBe(stall);
    await until(() => log.includes("close"));
    expect(log).toEqual(["push", "interrupt", "close"]);
    expect(records.find(({ type }) => type === "provider.claude_sdk.query.stopped")?.payload).toMatchObject({ reason: "abort", rule: "caller-signal", phase: "streaming" });
  }));

  test("a parked query of a client with a lifetime keeps its CLI however long it waits, and the end of the lifetime stops it with an interrupt", async () => {
    let log: readonly string[] = [];
    await withBridge(async (harness) => {
      log = harness.log;
      await parked(harness);
      await harness.advance(60 * 60_000);
      await settle();
      expect(harness.log).toEqual(["push"]);
    });
    expect(log).toEqual(["push", "interrupt", "close"]);
    expect(payloads("provider.claude_sdk.query.stopped")).toMatchObject([{ reason: "close", rule: "bridge-closed", phase: "parked", interrupted: true }]);
  });

  test("a cold rotation starts and serves the new engine on the session while the old engine's stop still waits for the token-refresh lock, and the old engine's close deletes nothing of the session and leaves its lock to the new engine", async () => {
    let lock: string | undefined;
    const configDir = temporaryDirectory("bridge-login-");
    await withBridge(async (harness) => {
      await parked(harness);
      harness.lock.held = true;
      const failed: MessageParam = { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "no such file" }], is_error: true }] };
      const second = await send(harness.ops, request([U1, A1, failed]));
      await until(() => harness.queries.length === 2 && harness.log.filter((entry) => entry === "push").length === 2);
      expect(harness.log).toEqual(["push", "interrupt", "push"]);
      const [old, replacement] = harness.queries;
      if (replacement === undefined) throw new Error("no replacement engine");
      const sessionId = replacement.launch.session.id;
      // Both generations resume one CLI session, so they share its one lock.
      expect(old?.launch.session.id).toBe(sessionId);
      lock = join(harness.config.configDir, "session-locks", `${sessionId}.lock`);
      const owner = readFileSync(lock, "utf8");
      expect([...harness.files.keys()]).toEqual([expect.stringMatching(new RegExp(`${sessionId}\\.jsonl$`, "u"))]);
      // The new engine serves while the old one waits, and deletes its transcript once it booted from it.
      replacement.emit(init, ...answers("Recovered."));
      expect(await second.error).toBeUndefined();
      expect(harness.log).toEqual(["push", "interrupt", "push"]);
      const files = [...harness.files.keys()];

      harness.lock.held = false;
      await harness.advance(200);
      await until(() => harness.log.includes("close"));
      expect(records.find(({ type }) => type === "provider.claude_sdk.query.stopped")?.payload).toMatchObject({
        reason: "rotation", rule: "undeliverable-result", phase: "parked", interrupted: true, overlapped: true,
      });
      // The old engine's close deletes nothing of the session and leaves its lock to the new engine.
      expect([[...harness.files.keys()], readFileSync(lock, "utf8")]).toEqual([files, owner]);
    }, { configDir });
    // The bridge releases the lock once its close joined every engine's stop.
    expect(lock !== undefined && existsSync(lock)).toBe(false);
  });

  test("an ended turn keeps its idle CLI with no provider traffic for an hour, and the next message goes to the same query", () => withBridge(async (harness) => {
    const first = await send(harness.ops, request([U1]));
    harness.queries[0]?.emit(init, ...answers("Done."));
    await first.read;
    await settle();
    for (let minute = 10; minute < 70; minute += 10) await harness.advance(10 * 60_000);
    expect(harness.log).toEqual(["push"]);
    expect(payloads("provider.claude_sdk.query.stopped")).toEqual([]);
    const next = await send(harness.ops, request([U1, A2, U2]));
    harness.queries[0]?.emit(...answers("Next."));
    expect(await next.error).toBeUndefined();
    expect(harness.queries).toHaveLength(1);
    expect(harness.log).toEqual(["push", "push"]);
  }));

  test("turning the module off releases a parked query's CLI at once, and a streaming query's CLI as soon as its request ends, and each drain asks the session to plan again once", () => {
    let stale = 0;
    return withBridge(async (harness) => {
      await parked(harness);
      releaseLiveBridges();
      await until(() => harness.log.includes("close"));
      expect(harness.log).toEqual(["push", "interrupt", "close"]);
      expect(stale).toBe(1);
      expect(payloads("provider.claude_sdk.query.stopped")).toMatchObject([{ reason: "release", rule: "module-off", phase: "parked" }]);
      const next = await send(harness.ops, request([U1, A1, R1]));
      const query = harness.queries[1];
      query?.emit(init, ...admittedStart(), ...text(0, "Do"));
      await until(() => next.types.length > 0);
      releaseLiveBridges();
      await settle();
      expect(harness.log).toEqual(["push", "interrupt", "close", "push"]);
      query?.emit(...text(1, "ne."), stopReason("end_turn"), messageStop);
      expect(await next.error).toBeUndefined();
      await until(() => harness.log.length === 5);
      expect(harness.log).toEqual(["push", "interrupt", "close", "push", "close"]);
      expect(payloads("provider.claude_sdk.query.stopped")).toMatchObject([{ rule: "module-off" }, { reason: "release", rule: "module-off", phase: "idle" }]);
      expect(stale).toBe(2);
    }, { demand: { scope: Scope.makeUnsafe("sequential"), stale: () => { stale += 1; } } });
  });

  test("a release of an idle CLI stops it at once, without an interrupt, and stops waiting for the lock at 35 s", () => withBridge(async (harness) => {
    harness.lock.held = true;
    const first = await send(harness.ops, request([U1]));
    harness.queries[0]?.emit(init, ...answers("Done."));
    await first.read;
    await settle();
    releaseLiveBridges();
    await settle();
    await harness.advance(0);
    await settle();
    await harness.advance(34_800);
    expect(harness.log).toEqual(["push"]);
    await harness.advance(200);
    await until(() => harness.log.includes("close"));
    expect(harness.log).toEqual(["push", "close"]);
    expect(records.find(({ type }) => type === "provider.claude_sdk.query.stopped")?.payload).toMatchObject({ reason: "release", rule: "module-off", interrupted: false, lockTimedOut: true });
  }));

  test("closing the bridge while a handler waits interrupts before the close, and the handler settles only after the CLI stopped", async () => {
    const order: string[] = [];
    await withBridge(async (harness) => {
      const { query } = await parked(harness);
      void callHandler(query, "toolu_1").then((result) => { order.push(...harness.log, `handler:${String(result.isError)}`); });
      await settle();
    });
    await until(() => order.length > 0);
    expect(order).toEqual(["push", "interrupt", "close", "handler:true"]);
  });

  test("a closed bridge fails a later request at once as transient", async () => {
    let closed: AnthropicOperations | undefined;
    await withBridge(async ({ ops }) => { closed = ops; });
    if (closed === undefined) throw new Error("the bridge never opened");
    const later = closed.createStream(request([U1]), { origins: originsOf(request([U1])), sharedHost: true, signal: new AbortController().signal, headers: {} }).then(() => "stream", (error: unknown) => error);
    const outcome = await Promise.race([later, settle().then(() => "still waiting")]);
    expect(outcome).toBeInstanceOf(LlmStreamError);
    expect(outcome).toMatchObject({ kind: "transient", message: "The Anthropic Subscription bridge closed" });
  });
});
