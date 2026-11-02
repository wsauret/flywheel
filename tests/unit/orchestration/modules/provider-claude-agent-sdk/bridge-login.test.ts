import { describe, expect, test } from "bun:test";
import {
  A2, answers, forwardDiagnostics, init, localLoginRefusal, logLines, MODEL_REQUEST_LINE, payloads, refused, request, send, settle, U1, U2, until, withBridge,
} from "./_bridge-harness.js";

forwardDiagnostics();

describe("the engine's sign-in diagnostics", () => {
  test("a local login fault retries the same request on a cold engine without rejecting the login", () => {
    return withBridge(async ({ ops, queries, outcomes }) => {
      const first = await send(ops, request([U1]));
      queries[0]?.emit(init);
      localLoginRefusal(queries[0]);
      await until(() => queries.length === 2);
      await until(() => queries[1]?.pushed.length === 1);
      expect(queries[0]?.exited).toBe(true);
      expect(queries[1]?.pushed[0]).toMatchObject({ message: { role: "user", content: U1.content } });
      expect(outcomes).toEqual([]);
      queries[1]?.emit(init, ...answers("Recovered."));
      expect(await first.read).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
      expect(outcomes).toEqual(["served"]);
      expect(payloads("provider.claude_sdk.query.stopped")[0]).toMatchObject({ evidence: { retry: "fresh-engine" } });
    });
  });

  test("an announced service refusal never retries even with an unresolved-authentication trace", () => withBridge(async ({ ops, queries, outcomes }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init);
    logLines(queries[0], [MODEL_REQUEST_LINE]);
    localLoginRefusal(queries[0]);
    expect(await first.error).toMatchObject({ name: "ProviderAuthenticationError" });
    await settle();
    expect(queries).toHaveLength(1);
    expect(outcomes).toEqual(["login-rejected"]);
  }));

  for (const source of ["caller", "controller"] as const) {
    test(`${source} abort settles the retry while the old engine waits for its refresh lock`, () => withBridge(async ({ ops, queries, lock, advance, outcomes }) => {
      const caller = new AbortController();
      const first = await send(ops, request([U1]), caller.signal);
      lock.held = true;
      localLoginRefusal(queries[0]);
      await settle();
      const reason = new Error("stop during retry cleanup");
      if (source === "caller") caller.abort(reason);
      else first.data.controller.abort(reason);
      const result = await Promise.race([first.error, settle().then(() => "still waiting")]);
      lock.held = false;
      await advance(200);
      expect(result).toBe(reason);
      await settle();
      expect(queries).toHaveLength(1);
      expect(queries[0]?.exited).toBe(true);
      expect(outcomes).toEqual([]);
      expect(payloads("provider.claude_sdk.query.stopped")[0]).toMatchObject({ evidence: { retry: "cancelled" } });
    }));

    test(`${source} abort settles the request during the fresh engine retry`, () => withBridge(async ({ ops, queries, outcomes }) => {
      const caller = new AbortController();
      const first = await send(ops, request([U1]), caller.signal);
      localLoginRefusal(queries[0]);
      await until(() => queries.length === 2);
      const reason = new Error("stop during retry");
      if (source === "caller") caller.abort(reason);
      else first.data.controller.abort(reason);
      expect(await first.error).toBe(reason);
      await until(() => queries[1]?.exited === true);
      expect(outcomes).toEqual([]);
    }));
  }

  test("a served request records the login as serving, and a refused login records the refusal, not an exit", () => withBridge(async ({ ops, queries, outcomes }) => {
    const first = await send(ops, request([U1]));
    logLines(queries[0], ["2026-10-15T00:28:13.679Z [ERROR] OAuth refresh failed (expected): secret-value"]);
    queries[0]?.emit(init, ...answers("Done."));
    await first.read;
    const second = await send(ops, request([U1, A2, U2]));
    queries[0]?.emit(...refused("authentication_failed", 401, "Invalid API key · Please run /login"));
    await second.error;
    await until(() => outcomes.length === 2);
    expect(outcomes).toEqual(["served", "login-rejected"]);
    expect(payloads("provider.claude_sdk.query.stopped")).toHaveLength(1);
    expect(payloads("provider.claude_sdk.query.stopped")[0]).not.toHaveProperty("signIn");
  }));

  test("a local login refusal records one bounded, content-free sign-in trace for its engine", () => withBridge(async ({ ops, queries, outcomes }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init);
    logLines(queries[0], [
      ...Array.from({ length: 40 }, () => "2026-10-15T00:28:13.677Z [WARN] [keychain] read failed; serving stale cache"),
      "2026-10-15T00:28:13.679Z [ERROR] OAuth refresh failed (expected): secret-value",
      "2026-10-15T00:28:13.676Z [ERROR] API error (attempt 1/11): Could not resolve authentication method. secret-value",
    ]);
    queries[0]?.emit(...refused("authentication_failed", null, "Not logged in · Please run /login"));
    await until(() => queries.length === 2);
    localLoginRefusal(queries[1]);
    expect(await first.error).toMatchObject({ name: "ProviderAuthenticationError" });
    await until(() => payloads("provider.claude_sdk.query.stopped").length === 2);
    queries[0]?.end();
    await settle();
    const stops = payloads("provider.claude_sdk.query.stopped");
    expect(stops).toHaveLength(2);
    expect(stops[0]).toMatchObject({
      cliVersion: "2.1.295", requests: 0, requestLines: {}, evidence: { report: "authentication_failed" },
      signIn: { omitted: 10, signals: [
        ...Array.from({ length: 30 }, () => ({ kind: "keychain-read-failed-stale", sinceStartMs: expect.any(Number) })),
        { kind: "refresh-failed", sinceStartMs: expect.any(Number) },
        { kind: "authentication-unresolved", sinceStartMs: expect.any(Number) },
      ] },
    });
    expect(JSON.stringify(stops)).not.toContain("secret-value");
    expect(JSON.stringify(stops)).not.toContain("Could not resolve");
    expect(JSON.stringify(stops)).not.toContain("serving stale cache");
    expect(outcomes).toEqual(["login-rejected"]);
    expect(queries).toHaveLength(2);
  }));
});
