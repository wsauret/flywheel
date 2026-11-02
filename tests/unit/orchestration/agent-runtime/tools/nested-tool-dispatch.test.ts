import { describe, expect, it, spyOn } from "bun:test";
import * as treeSitter from "../../../../../src/infra/tree-sitter-parser.js";
import { interceptBashCommand } from "../../../../../src/orchestration/agent-runtime/tools/bash-command-policy.js";
import { Effect } from "effect";
import { createNestedToolDispatchBatch, createNestedToolFactPublisher, type NestedToolFactPublisher } from "../../../../../src/orchestration/agent-runtime/tools/nested-tool-dispatch.js";
import { createToolConcurrencyGate } from "../../../../../src/orchestration/agent-runtime/tools/tool-concurrency-gate.js";
import type { RuntimeTool, ToolContext, ToolResult } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import type { SessionFactWriter } from "../../../../../src/orchestration/session/session-fact-writer.js";
import type { EventPayload, StoredFact } from "../../../../../src/infra/event-store-types.js";
import { RequestToolMap } from "../../../../helpers/request-tool-surface.js";
import { SLOW_UNIT_BUDGET_MS } from "../../../../../src/infra/event-loop-lag.js";
import { Log } from "../../../../../src/infra/log.js";
import { createHandoffTracker } from "../../../../../src/orchestration/agent-runtime/agent-loop-handoff.js";
import { largeSecretResult, resultRecordingWriter } from "./_nested-tool-dispatch-fixtures.js";

function context(): ToolContext {
  return {
    executionCwd: process.cwd(),
    userDataRoot: "/scratch/test-account", projectRoot: process.cwd(),
    artifactScopeId: "session",
    retrievalSessionId: "session",
    sessionId: "session",
  };
}

function tool(name: string, execute: RuntimeTool["execute"]): RuntimeTool {
  return {
    name,
    action: "file_read",
    description: name,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    isConcurrencySafe: true,
    execute,
  };
}

function publisher(events: string[]): NestedToolFactPublisher {
  return {
    input: (call) => { events.push(`input:${call.id}`); },
    validation: (call) => { events.push(`validation:${call.id}`); },
    output: (call, output) => { events.push(`output:${call.id}:${output}`); },
    result: (call, result) => { events.push(`result:${call.id}:${result.outcome}`); },
  };
}

describe("nested tool dispatch batch", () => {
  it.each(["before dispatch", "while queued", "with malformed input"] as const)("refuses a nested call after handoff starts %s", async (when) => {
    const events: string[] = [];
    let executions = 0;
    const tracker = createHandoffTracker(), admission = tracker.request();
    const gate = createToolConcurrencyGate(1);
    const release = await gate.acquire({ kind: "safe" });
    const entered = Promise.withResolvers<void>();
    const acquire = gate.acquire.bind(gate);
    gate.acquire = (...args) => { entered.resolve(); return acquire(...args); };
    const read = tool("read", async () => { executions++; return { content: "ran", outcome: "ok" }; });
    const batch = createNestedToolDispatchBatch({
      executionAdmission: () => ({ ok: true }), tools: new RequestToolMap([[read.name, read]]),
      context: { ...context(), refuseAfterHandoff: admission.refuse }, gate,
      parentToolUseId: "outer", publisher: publisher(events),
    });
    if (when !== "while queued") admission.start({ id: "finish" });
    const result = Effect.runPromise(batch.execute("read", when === "with malformed input" ? null : {}));
    if (when === "while queued") { await entered.promise; admission.start({ id: "finish" }); }
    release();
    expect(await result).toMatchObject({ outcome: "blocked", content: expect.stringContaining("session ended") });
    await Effect.runPromise(batch.close());
    expect(executions).toBe(0);
    expect(events).toContain("result:outer#1:blocked");
    if (when === "with malformed input") expect(events).toEqual(["result:outer#1:blocked"]);
  });

  it("commits input before execution and assigns monotonic parented ids", async () => {
    const events: string[] = [];
    const calls: string[] = [];
    const read = tool("read", async (_input, ctx): Promise<ToolResult> => {
      calls.push(ctx.toolUseId ?? "missing");
      return { content: "ok", outcome: "ok" };
    });
    const batch = createNestedToolDispatchBatch({
      executionAdmission: () => ({ ok: true }),
      tools: new RequestToolMap([[read.name, read]]),
      context: context(),
      gate: createToolConcurrencyGate(10),
      parentToolUseId: "outer",
      modelRequestId: "request",
      publisher: publisher(events),
    });

    const results = await Effect.runPromise(Effect.all([
      batch.execute("read", {}),
      batch.execute("read", {}),
    ], { concurrency: "unbounded" }));
    await Effect.runPromise(batch.close());

    expect(results.map((result) => result.outcome)).toEqual(["ok", "ok"]);
    expect(calls.sort()).toEqual(["outer#1", "outer#2"]);
    expect(events.indexOf("input:outer#1")).toBeLessThan(events.indexOf("result:outer#1:ok"));
    expect(events.filter((event) => event.startsWith("result:"))).toHaveLength(2);
  });

  it("emits one redacted parent breadcrumb after input publication and before execution", async () => {
    const events: string[] = [];
    const secret = ["Bearer", "fixturevalue123"].join(" ");
    const nested = tool("context7.resolve-library-id", async (): Promise<ToolResult> => {
      events.push("execute");
      return { content: "ok", outcome: "ok" };
    });
    nested.inputSchema = { type: "object", properties: { nested: { type: "object" } }, required: ["nested"] };
    const batch = createNestedToolDispatchBatch({
      executionAdmission: () => ({ ok: true }),
      tools: new RequestToolMap([[nested.name, nested]]), context: context(), gate: createToolConcurrencyGate(10),
      parentToolUseId: "outer", publisher: publisher(events), onNestedStart: (line) => { events.push(`breadcrumb:${line}`); },
    });

    await Effect.runPromise(batch.execute(nested.name, { nested: { token: secret } }));
    await Effect.runPromise(batch.close());

    expect(events.slice(0, 3)).toEqual([
      "input:outer#1",
      'breadcrumb:-> tools.context7["resolve-library-id"] {"nested":{"token":"[redacted secret]"}}',
      "execute",
    ]);
    expect(events.filter((event) => event.startsWith("output:"))).toHaveLength(0);
  });

  it("uses validation as the sole terminal evidence for invalid and unknown calls", async () => {
    const events: string[] = [];
    let executions = 0;
    const strict = tool("strict", async (): Promise<ToolResult> => {
      executions += 1;
      return { content: "ran", outcome: "ok" };
    });
    strict.inputSchema = { type: "object", properties: { value: { type: "string" } }, required: ["value"] };
    const batch = createNestedToolDispatchBatch({
      executionAdmission: () => ({ ok: true }),
      tools: new RequestToolMap([[strict.name, strict]]),
      context: context(),
      gate: createToolConcurrencyGate(10),
      parentToolUseId: "outer",
      publisher: publisher(events),
    });

    const invalid = await Effect.runPromise(batch.execute("strict", {}));
    const unknown = await Effect.runPromise(batch.execute("missing", {}));
    await Effect.runPromise(batch.close());

    expect(invalid.outcome).toBe("error");
    expect(unknown.outcome).toBe("error");
    expect(executions).toBe(0);
    expect(events).toEqual(["validation:outer#1", "validation:outer#2"]);
  });

  it("reads a repaired name and complete JSON-text input through the ordinary dispatch boundary", async () => {
    const received: unknown[] = [];
    const read = tool("read", async input => { received.push(input); return { content: "ran", outcome: "ok" }; });
    read.inputSchema = { type: "object", properties: { count: { type: "number" } }, required: ["count"] };
    const events: string[] = [];
    const validations: ToolResult[] = [];
    const results: ToolResult[] = [];
    const batch = createNestedToolDispatchBatch({
      executionAdmission: name => name === "read" ? { ok: true } : { ok: false, refusal: { content: "wrong tool name", outcome: "error" } },
      tools: new RequestToolMap([["read", read]]), context: context(),
      gate: createToolConcurrencyGate(10), parentToolUseId: "outer", publisher: {
        ...publisher(events),
        validation: (_call, result) => { validations.push(result); },
        result: (_call, result) => { results.push(result); },
      },
    });
    const result = await Effect.runPromise(batch.execute("Read", '{"count":"2"}'));
    expect(result.outcome).toBe("ok");
    expect(String(result.content)).toContain("Note: the text value of `input` was read as an object.");
    expect(String(result.content)).toContain("Note: the text value of `count` was read as a number.");
    expect(received).toEqual([{ count: 2 }]);
    const invalid = await Effect.runPromise(batch.execute("Read", "{}"));
    expect(invalid.outcome).toBe("error");
    expect(invalid.content).toStartWith("Note: the text value of `input` was read as an object.\nNote: tool 'Read' was read as 'read'.\n");
    expect(invalid.content).toContain("count");
    expect(validations.at(-1)).toEqual(invalid);
    read.prepareAdmission = async () => ({});
    const afterPreparation = await Effect.runPromise(batch.execute("Read", "{}"));
    expect(afterPreparation.outcome).toBe("error");
    expect(afterPreparation.content).toStartWith("Note: the text value of `input` was read as an object.\nNote: tool 'Read' was read as 'read'.\n");
    expect(results.at(-1)).toEqual(afterPreparation);
    for (const rawInput of ['{"count":', [], null, 2]) expect((await Effect.runPromise(batch.execute("read", rawInput))).outcome).toBe("error");
    await Effect.runPromise(batch.close());
    expect(received).toHaveLength(1);
  });

  it("does not emit a breadcrumb when validation fails", async () => {
    const events: string[] = [];
    const strict = tool("strict", async (): Promise<ToolResult> => ({ content: "ran", outcome: "ok" }));
    strict.inputSchema = { type: "object", properties: { value: { type: "string" } }, required: ["value"] };
    const batch = createNestedToolDispatchBatch({
      executionAdmission: () => ({ ok: true }),
      tools: new RequestToolMap([[strict.name, strict]]), context: context(), gate: createToolConcurrencyGate(10),
      parentToolUseId: "outer", publisher: publisher(events), onNestedStart: (line) => { events.push(`breadcrumb:${line}`); },
    });
    await Effect.runPromise(batch.execute("strict", {}));
    await Effect.runPromise(batch.close());
    expect(events).toEqual(["validation:outer#1"]);
  });

  it("does not emit a breadcrumb when input publication fails", async () => {
    const breadcrumbs: string[] = [];
    let executed = false;
    const probe = tool("probe", async (): Promise<ToolResult> => {
      executed = true;
      return { content: "ran", outcome: "ok" };
    });
    const batch = createNestedToolDispatchBatch({
      executionAdmission: () => ({ ok: true }),
      tools: new RequestToolMap([[probe.name, probe]]), context: context(), gate: createToolConcurrencyGate(10),
      parentToolUseId: "outer", onNestedStart: (line) => { breadcrumbs.push(line); },
      publisher: { input: () => Promise.reject(new Error("write failed")), validation: () => {}, output: () => {}, result: () => {} },
    });
    await Effect.runPromiseExit(batch.execute("probe", {}));
    await Effect.runPromise(batch.close());
    expect(breadcrumbs).toEqual([]);
    expect(executed).toBe(false);
  });

  it("closes admission, drains work, and publishes one tombstone after interruption", async () => {
    const events: string[] = [];
    const started = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const slow = tool("slow", async (_input, ctx): Promise<ToolResult> => {
      started.resolve();
      await new Promise<void>((resolve) => {
        if (ctx.signal?.aborted) resolve();
        else ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      stopped.resolve();
      return { content: "stopped", outcome: "interrupted" };
    });
    const batch = createNestedToolDispatchBatch({
      executionAdmission: () => ({ ok: true }),
      tools: new RequestToolMap([[slow.name, slow]]),
      context: context(),
      gate: createToolConcurrencyGate(10),
      parentToolUseId: "outer",
      publisher: publisher(events),
    });

    const running = Effect.runPromiseExit(batch.execute("slow", {}));
    await started.promise;
    await Effect.runPromise(batch.close());
    await stopped.promise;
    await running;

    expect(events.filter((event) => event === "result:outer#1:interrupted")).toHaveLength(1);
    const late = await Effect.runPromise(batch.execute("slow", {}));
    expect(late).toEqual({ content: "Code tool dispatch is closed.", outcome: "interrupted" });
    expect(events.filter((event) => event.startsWith("input:"))).toHaveLength(1);
  });

  it("settles interruption during execution policy without executing after the policy finishes", async () => {
    const events: string[] = [];
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    const loadParser = treeSitter.loadTreeSitterParser;
    const parserLoad = spyOn(treeSitter, "loadTreeSitterParser").mockImplementation(async (language) => {
      started.resolve();
      await release.promise;
      const parser = await loadParser(language);
      completed.resolve();
      return parser;
    });
    let executions = 0;
    const bash: RuntimeTool = {
      ...tool("bash", async () => {
        executions++;
        return { content: "ran", outcome: "ok" };
      }),
      inputSchema: { type: "object", properties: { command: { type: "string" } } },
      // The shell's policy loads the parser on its first call.
      executionPolicy: async (input) => (await interceptBashCommand(String(input.command)))?.message,
    };
    const batch = createNestedToolDispatchBatch({
      executionAdmission: () => ({ ok: true }),
      tools: new RequestToolMap([["bash", bash]]),
      context: context(),
      gate: createToolConcurrencyGate(10),
      parentToolUseId: "outer",
      publisher: publisher(events),
    });
    try {
      const running = Effect.runPromiseExit(batch.execute("bash", { command: "pwd" }));
      await started.promise;
      await Effect.runPromise(batch.close());
      await running;
      release.resolve();
      await completed.promise;
      expect(executions).toBe(0);
      expect(events.filter((event) => event.startsWith("result:"))).toEqual(["result:outer#1:interrupted"]);
    } finally {
      release.resolve();
      parserLoad.mockRestore();
      await Effect.runPromise(batch.close());
    }
  });

  it("records live output with the child identity", async () => {
    const events: string[] = [];
    const noisy = tool("noisy", async (_input, ctx): Promise<ToolResult> => {
      ctx.onExecutionOutput?.("half");
      return { content: "done", outcome: "ok" };
    });
    const batch = createNestedToolDispatchBatch({
      executionAdmission: () => ({ ok: true }),
      tools: new RequestToolMap([[noisy.name, noisy]]),
      context: context(),
      gate: createToolConcurrencyGate(10),
      parentToolUseId: "outer",
      publisher: publisher(events),
    });

    await Effect.runPromise(batch.execute("noisy", {}));
    await Effect.runPromise(batch.close());

    expect(events).toContain("output:outer#1:half");
  });

  it("publishes causal metadata and post-validation policy rejection as one result", async () => {
    const facts: Array<{ kind: string; parent: string; request?: string }> = [];
    let executed = false;
    const blocked = tool("blocked", async (): Promise<ToolResult> => {
      executed = true;
      return { content: "ran", outcome: "ok" };
    });
    const batch = createNestedToolDispatchBatch({
      executionAdmission: () => ({ ok: true }),
      tools: new RequestToolMap([[blocked.name, blocked]]), context: context(), gate: createToolConcurrencyGate(10),
      parentToolUseId: "outer", modelRequestId: "request",
      executionWhitelist: { tools: new Set(), deniedReason: () => "denied" },
      publisher: {
        input: (_call, _tool, meta) => { facts.push({ kind: "input", parent: meta.parentToolUseId, request: meta.modelRequestId }); },
        validation: (_call, _result, meta) => { facts.push({ kind: "validation", parent: meta.parentToolUseId, request: meta.modelRequestId }); },
        output: () => {},
        result: (_call, _result, meta) => { facts.push({ kind: "result", parent: meta.parentToolUseId, request: meta.modelRequestId }); },
      },
    });
    const result = await Effect.runPromise(batch.execute("blocked", {}));
    await Effect.runPromise(batch.close());
    expect(result).toEqual({ content: "denied", outcome: "error" });
    expect(executed).toBe(false);
    expect(facts).toEqual([
      { kind: "input", parent: "outer", request: "request" },
      { kind: "result", parent: "outer", request: "request" },
    ]);
  });

  it("records one terminal fact when result publication fails before close", async () => {
    const terminals: string[] = [];
    let first = true;
    const probe = tool("probe", async (): Promise<ToolResult> => ({ content: "done", outcome: "ok" }));
    const batch = createNestedToolDispatchBatch({
      executionAdmission: () => ({ ok: true }),
      tools: new RequestToolMap([[probe.name, probe]]), context: context(), gate: createToolConcurrencyGate(10), parentToolUseId: "outer",
      publisher: {
        input: () => {}, validation: () => {}, output: () => {},
        result: (call, result) => {
          if (first) { first = false; return Promise.reject(new Error("publication race")); }
          terminals.push(`${call.id}:${result.outcome}`);
        },
      },
    });
    await Effect.runPromiseExit(batch.execute("probe", {}));
    await Effect.runPromise(batch.close());
    expect(terminals).toEqual(["outer#1:interrupted"]);
  });

  it("commits ordinary parent-linked input before the host effect and then one result", async () => {
    const facts: Array<{ readonly type: string; readonly payload: EventPayload }> = [];
    const stored = (fact: { readonly type: string; readonly version: number; readonly actor: string; readonly payload: EventPayload }): StoredFact => ({
      aggregateId: "session:session", type: fact.type, version: fact.version, timestamp: Date.now(), actor: fact.actor,
      sessionId: "session", payload: fact.payload, position: facts.length, id: `event-${facts.length}`, seq: facts.length,
    });
    const writer: SessionFactWriter = {
      record: async (fact) => { facts.push(fact); return stored(fact); },
      recordBatch: async () => { throw new Error("unused request audit"); },
      recordGuarded: async (fact) => { facts.push(fact); return { kind: "stored", events: [stored(fact)] }; },
      transaction: async (fn) => { fn(); },
      dispose: () => {},
    };
    const inputProjection = Promise.withResolvers<void>();
    const inputStarted = Promise.withResolvers<void>();
    const resultProjection = Promise.withResolvers<void>();
    const resultStarted = Promise.withResolvers<void>();
    let executed = false;
    let completed = false;
    const durableContext = {
      ...context(), sessionEventWriter: writer,
      applyNestedStoredFact: async (fact: StoredFact) => {
        if (fact.type === "tool.input.completed") {
          inputStarted.resolve();
          await inputProjection.promise;
        } else {
          resultStarted.resolve();
          await resultProjection.promise;
        }
      },
    };
    const probe = tool("probe", async (): Promise<ToolResult> => {
      executed = true;
      expect(facts.map((fact) => fact.type)).toEqual(["tool.input.completed"]);
      return { content: "done", outcome: "ok" };
    });
    const batch = createNestedToolDispatchBatch({
      executionAdmission: () => ({ ok: true }),
      tools: new RequestToolMap([[probe.name, probe]]), context: durableContext, gate: createToolConcurrencyGate(10),
      parentToolUseId: "outer", modelRequestId: "request", publisher: createNestedToolFactPublisher(durableContext),
    });
    const running = Effect.runPromise(batch.execute("probe", {})).then(() => { completed = true; });
    await inputStarted.promise;
    await Bun.sleep(1);
    expect(executed).toBe(false);
    inputProjection.resolve();
    await resultStarted.promise;
    await Bun.sleep(1);
    expect(completed).toBe(false);
    resultProjection.resolve();
    await running;
    await Effect.runPromise(batch.close());

    expect(facts.map((fact) => fact.type)).toEqual(["tool.input.completed", "tool.result.recorded"]);
    expect(facts.map((fact) => "parentToolUseId" in fact.payload ? fact.payload.parentToolUseId : undefined)).toEqual(["outer", "outer"]);
  });

  it("propagates an asynchronous nested projection rejection", async () => {
    const failure = new Error("nested projection failed");
    const projection = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const writer: SessionFactWriter = {
      record: async (fact) => ({
        aggregateId: "session:session", type: fact.type, version: fact.version,
        timestamp: Date.now(), actor: fact.actor, sessionId: "session",
        payload: fact.payload, position: 1, id: "event-1", seq: 1,
      }),
      recordBatch: async () => null,
      recordGuarded: async () => null,
      transaction: async (fn) => { fn(); },
      dispose: () => {},
    };
    const durable = createNestedToolFactPublisher({
      ...context(), sessionEventWriter: writer,
      applyNestedStoredFact: async () => { started.resolve(); await projection.promise; },
    });
    const result = Promise.resolve(durable.input(
      { id: "outer#1", name: "probe", input: {} },
      tool("probe", async () => ({ content: "done", outcome: "ok" })),
      { parentToolUseId: "outer", modelRequestId: "request" },
    )).then(() => null, (error: unknown) => error);
    await started.promise;
    projection.reject(failure);
    expect(await result).toBe(failure);
  });

  it("prepares two large results in alternating tasks and records each one redacted, in publication order", async () => {
    const records: string[] = [];
    const writer = resultRecordingWriter(records);
    // Every unit ends its slice, and each yield waits until the test releases it.
    const parked: Array<() => void> = [];
    let clock = 0;
    const durable = createNestedToolFactPublisher({ ...context(), sessionEventWriter: writer }, {
      now: () => (clock += SLOW_UNIT_BUDGET_MS),
      yieldToNextTask: () => new Promise((resolve) => { parked.push(resolve); }),
    });
    const settle = () => Bun.sleep(0);
    const releaseAll = async () => {
      for (let release = parked.shift(); release !== undefined; release = parked.shift()) {
        release();
        await settle();
      }
    };
    const publish = (id: string) => durable.result(...largeSecretResult(id));

    const first = publish("outer#1");
    const second = publish("outer#2");
    await settle();
    expect(parked).toHaveLength(2);

    // The second result completes its preparation while the first waits at its
    // first yield, and it records only after the first.
    const firstYield = parked.shift();
    await releaseAll();
    expect(records).toEqual([]);
    firstYield?.();
    await settle();
    await releaseAll();
    await Promise.all([first, second]);

    expect(records).toEqual(["outer#1:redacted", "outer#2:redacted"]);
  });

  it("records a later result when the result published before it fails to record", async () => {
    const records: string[] = [];
    const durable = createNestedToolFactPublisher({ ...context(), sessionEventWriter: resultRecordingWriter(records, "outer#1") });

    const first = durable.result(...largeSecretResult("outer#1"));
    const second = durable.result(...largeSecretResult("outer#2"));

    await expect(Promise.resolve(first)).rejects.toThrow("Nested tool fact 'tool.result.recorded' was not persisted.");
    await second;
    expect(records).toEqual(["outer#2:redacted"]);
  });

  it("records results when execution output fails to record, and logs the failures once with a count", async () => {
    const warn = spyOn(Log.create({ service: "nested-tool-dispatch" }), "warn").mockImplementation(() => {});
    try {
      const records: string[] = [];
      const base = resultRecordingWriter(records);
      let outputStoreUp = false;
      const writer: SessionFactWriter = {
        ...base,
        record: (fact, contentRows) => fact.type === "tool.execution_output.recorded" && !outputStoreUp
          ? Promise.reject(new Error("output store unavailable"))
          : base.record(fact, contentRows),
      };
      const durable = createNestedToolFactPublisher({ ...context(), sessionEventWriter: writer });
      const meta = { parentToolUseId: "outer" };
      const call = (id: string) => ({ id, name: "probe", input: {} });

      // No result awaits this flush, so its failure must not escape unhandled.
      durable.output(call("outer#1"), "first", meta);
      await Bun.sleep(0);
      durable.output(call("outer#1"), "second", meta);
      durable.output(call("outer#2"), "other", meta);
      await durable.result(...largeSecretResult("outer#1"));
      expect(records).toEqual(["outer#1:redacted"]);
      expect(warn.mock.calls).toEqual([
        ["nested tool execution output was not recorded", { sessionId: "session", toolUseId: "outer#1", error: "output store unavailable" }],
      ]);

      // The next output record that succeeds ends the condition and reports its repeats.
      outputStoreUp = true;
      durable.output(call("outer#2"), "recovered", meta);
      await durable.result(...largeSecretResult("outer#2"));
      expect(records).toEqual(["outer#1:redacted", "outer#2:raw", "outer#2:redacted"]);
      expect(warn.mock.calls[1]).toEqual(["nested tool execution output was not recorded again", {
        sessionId: "session", count: 2, windowMs: expect.any(Number), error: "output store unavailable",
      }]);
    } finally {
      warn.mockRestore();
    }
  });

  it("redacts durable leaves and coalesces a synchronous progress burst", async () => {
    const facts: Array<{ readonly type: string; readonly payload: EventPayload }> = [];
    const projected: StoredFact[] = [];
    const writer: SessionFactWriter = {
      recordBatch: async () => { throw new Error("unused request audit"); },
      record: async (fact) => {
        facts.push(fact);
        return { aggregateId: "session:session", type: fact.type, version: fact.version, timestamp: Date.now(), actor: fact.actor,
          sessionId: "session", payload: fact.payload, position: facts.length, id: `event-${facts.length}`, seq: facts.length };
      },
      recordGuarded: async () => null,
      transaction: async (fn) => { fn(); },
      dispose: () => {},
    };
    const durableContext = { ...context(), sessionEventWriter: writer, applyNestedStoredFact: (event: StoredFact) => { projected.push(event); } };
    const secret = ["Bearer", "fixturevalue123"].join(" ");
    const noisy = tool("noisy", async (_input, ctx): Promise<ToolResult> => {
      for (let index = 0; index < 1_000; index += 1) ctx.onExecutionOutput?.(`line-${index}\n${secret}`);
      return { content: `result\n${secret}`, outcome: "ok", details: { token: secret } };
    });
    const batch = createNestedToolDispatchBatch({
      executionAdmission: () => ({ ok: true }),
      tools: new RequestToolMap([[noisy.name, noisy]]), context: durableContext, gate: createToolConcurrencyGate(10),
      parentToolUseId: "outer", publisher: createNestedToolFactPublisher(durableContext),
    });
    await Effect.runPromise(batch.execute("noisy", { nested: { token: secret } }));
    await Effect.runPromise(batch.close());

    expect(facts.filter((fact) => fact.type === "tool.execution_output.recorded").length).toBeLessThan(10);
    expect(JSON.stringify(facts)).not.toContain(secret);
    expect(projected.map((event) => event.id)).toEqual(facts.map((_fact, index) => `event-${index + 1}`));
  });
});
