import { describe, expect, it, spyOn } from "bun:test";
import { Effect } from "effect";
import { createNestedToolDispatchBatch } from "../../../../../src/orchestration/agent-runtime/tools/nested-tool-dispatch.js";
import { createToolConcurrencyGate } from "../../../../../src/orchestration/agent-runtime/tools/tool-concurrency-gate.js";
import { boundedStringCodeModeOutput, type RuntimeTool, type ToolContext, type ToolResult } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { createCatalogRenderer } from "../../../../../src/orchestration/modules/code-mode/catalog.js";
import type { CodeModeLimits } from "../../../../../src/orchestration/modules/code-mode/limits.js";
import { codeModeRuntimeOver, codeModeServices, codeToolOver, scriptedWorker } from "../../../../helpers/code-mode-worker.js";
import { composeModuleRuntimes } from "../../../../../src/infra/module-runtime.js";
import { composeFirstPartyModules } from "../../../../../src/orchestration/modules.js";
import { planToolExposure } from "../../../../../src/orchestration/agent-runtime/tools/tool-exposure-planner.js";
import { testKernelToolDeps } from "../../../../helpers/request-tool-surface.js";

function runtimeTool(name: string, execute: RuntimeTool["execute"]): RuntimeTool {
  return {
    name,
    action: "file_read",
    description: `${name} fixture`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    codeMode: "exclusive",
    codeModeOutput: boundedStringCodeModeOutput,
    isConcurrencySafe: true,
    execute,
  };
}

const codeModeService = codeModeServices();

function fixture(tools: RuntimeTool[], limits: Partial<CodeModeLimits> = {}, service = codeModeService({ limits })) {
  const eligibleTools = new Map(tools.map((tool) => [tool.name, tool]));
  const facts: string[] = [];
  const outputs: string[] = [];
  const base: ToolContext = {
    executionCwd: process.cwd(),
    userDataRoot: "/scratch/test-account", projectRoot: process.cwd(),
    artifactScopeId: "session",
    retrievalSessionId: "session",
    sessionId: "session",
    toolUseId: "outer",
    onExecutionOutput: (output) => outputs.push(output),
  };
  base.createNestedToolDispatchBatch = (options) => createNestedToolDispatchBatch({
    ...options,
    executionAdmission: () => ({ ok: true }),
    context: base,
    gate: createToolConcurrencyGate(10),
    publisher: {
      input: (call) => { facts.push(`input:${call.id}`); },
      validation: (call) => { facts.push(`validation:${call.id}`); },
      output: (call) => { facts.push(`output:${call.id}`); },
      result: (call, result) => { facts.push(`result:${call.id}:${result.outcome}`); },
    },
  });
  return { tool: codeToolOver(eligibleTools, service), context: base, facts, outputs };
}

function captureLogTimers() {
  const callbacks = new Map<Parameters<typeof clearTimeout>[0], () => void>();
  const originalClear = globalThis.clearTimeout;
  const originalTimeout = globalThis.setTimeout;
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation(new Proxy(originalTimeout, {
    apply(target, _receiver, args: Parameters<typeof setTimeout>) {
      if (args[1] !== 50) return target(...args);
      const handle = target(() => {}, 0);
      originalClear(handle);
      callbacks.set(handle, () => { args[0](...args.slice(2)); });
      return handle;
    },
  }));
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(new Proxy(originalClear, {
    apply(target, _receiver, args: Parameters<typeof clearTimeout>) {
      callbacks.delete(args[0]);
      target(...args);
    },
  }));
  return {
    callbacks,
    tick() {
      const current = [...callbacks.values()];
      callbacks.clear();
      for (const flush of current) flush();
    },
    restore() { timeout.mockRestore(); clear.mockRestore(); },
  };
}

describe("code tool", () => {
  it("uses the mirrored Code Mode description and guidelines", () => {
    const { tool } = fixture([]);
    const description = [
      "Run JavaScript in a confined Code Mode runtime to orchestrate tool calls and compose their results.",
      "Imports, direct filesystem access, and timers are unavailable. Do not use `fetch`; all external access goes through `tools`.",
      "Within `{ source }`, only tools listed in the Code Mode catalog or returned by `searchCatalog` are callable. Call first-class tools directly, never through code.",
      "`searchCatalog` is a global function, never a member of `tools`. Call `searchCatalog(input)`, not `tools.searchCatalog(input)`.",
      'Call tools through `tools` using only exact paths and signatures from the catalog. Do not infer or normalize tool names; preserve bracket notation such as `tools.<namespace>["tool-name"](input)`.',
      "For discovery, run one script that makes all independent `searchCatalog` calls concurrently with `Promise.all`. Then run one separate real-work script with the discovered exact tool paths and signatures.",
      "Prefer an explicit `return`; if omitted, the final top-level expression becomes the result.",
      "Await every call whose completion matters; pending calls are interrupted when execution ends. Run independent calls concurrently with `Promise.all`.",
      "Tool results are `{ outcome, content }`. `content` arrives parsed when the tool's text output is a JSON object or array; otherwise it is a string.",
      "Post-process results in the same script, the way shell commands pipe into filters: never return a raw result. Map it to only the fields the task needs and return that projection.",
      "Discover an unknown shape inside the script, not in your context: probe with a small limit, log `Object.keys(...)` or one sample item with `console.log`, then project defensively with optional chaining.",
      "A large return value does not fail: the runtime truncates it for the model and saves the full result to a breadcrumb file. Treat that as a missed projection; re-run the script with a tighter projection instead of post-processing the breadcrumb.",
    ];
    expect(tool.description).toBe(description.join("\n"));
    expect(tool.uncappedOutput).toBeUndefined();
    // The description is the one home of the script rules (ARCH-CONTEXT-035); the guidelines add only what it lacks.
    expect(tool.promptGuidelines).toEqual([
      "Heavy computation and gigabyte-scale data belong in Bash; exceeding the heap growth budget terminates the program. Program intermediates never enter model context.",
      createCatalogRenderer()({}).text,
    ]);
  });
  it("describes a script runtime with no tool calls, catalog, or Bash advice when the capture holds neither code-only tools nor bash", async () => {
    const planned = await planToolExposure({
      kernel: testKernelToolDeps({ moduleSnapshot: composeFirstPartyModules(undefined, ["mcp", "bash"]) }),
      modules: composeModuleRuntimes([["code-mode", codeModeRuntimeOver(codeModeService())]]),
    });
    const code = planned.tools.get("code");
    const text = [code?.description, ...code?.promptGuidelines ?? []].join("\n");
    expect(code?.description).toBe([
      "Run JavaScript in a confined Code Mode runtime to compute and compose results.",
      "Imports, direct filesystem access, timers, and `fetch` are unavailable.",
      "Prefer an explicit `return`; if omitted, the final top-level expression becomes the result.",
      "A large return value does not fail: the runtime truncates it for the model and saves the full result to a breadcrumb file. Treat that as a missed projection; re-run the script with a tighter projection instead of post-processing the breadcrumb.",
    ].join("\n"));
    expect(text).not.toContain("searchCatalog");
    expect(text).not.toContain("## Namespaces");
    expect(text).not.toContain("Bash");
    expect(text).toContain("Exceeding the heap growth budget terminates the program.");
  });
  it("formats successful string and structured values for the model", async () => {
    const run = fixture([]);
    const text = await run.tool.execute({ source: 'return "plain value"' }, run.context);
    const structured = await run.tool.execute({ source: "return { answer: 42, nested: [true] }" }, run.context);

    expect(text.content).toBe("plain value");
    expect(structured.content).toBe('{\n  "answer": 42,\n  "nested": [\n    true\n  ]\n}');
  });
  it("returns a 64 KiB result byte-identically: Code carries no private output cap", async () => {
    const run = fixture([]);
    const expected = "x".repeat(64 * 1024);
    const result = await run.tool.execute({ source: `return "${expected}"` }, run.context);

    expect(result.content).toBe(expected);
  });

  it("bounds default logs without truncating the return or retaining later small lines", async () => {
    const run = fixture([]);
    const expected = "r".repeat(64 * 1024);
    const result = await run.tool.execute({
      source: `console.log("prefix"); console.log("x".repeat(50 * 1024)); console.log("later"); return "${expected}"`,
    }, run.context);
    const [returned, logs] = String(result.content).split("\n\nLogs:\n");
    expect(returned).toBe(expected);
    expect(logs?.length).toBeLessThan(200);
    expect(logs).toBe("prefix\n[2 more console lines dropped after the 51200-byte retention budget]");
    expect(run.outputs.at(-1)).toBe("prefix\n[2 more console lines dropped after the 51200-byte retention budget]");
  });

  it("redacts a retained private-key prefix whose END line is cut without consuming the return", async () => {
    const begin = `-----BEGIN ${"RSA PRIVATE KEY"}-----`;
    const end = `-----END ${"RSA PRIVATE KEY"}-----`;
    const body = "private-body";
    const run = fixture([], { maxLogBytes: Buffer.byteLength(`${begin}\n${body}\n`) });
    const result = await run.tool.execute({
      source: `console.log(${JSON.stringify(begin)}); console.log(${JSON.stringify(body)}); console.log(${JSON.stringify(end)}); console.log("later"); return "full-return"`,
    }, run.context);
    expect(result.content).toBe("full-return\n\nLogs:\n[redacted secret]");
    expect(run.outputs.at(-1)).toBe("[redacted secret]\n\n");
    expect(JSON.stringify(result)).not.toContain(body);
  });

  it("keeps complete-mode redaction for untruncated logs and returned values", async () => {
    const incomplete = `-----BEGIN ${"PRIVATE KEY"}-----\nordinary-incomplete-body`;
    const run = fixture([], { maxLogBytes: 1 });
    const result = await run.tool.execute({
      source: `console.log("dropped"); return ${JSON.stringify(incomplete)}`,
    }, run.context);
    expect(String(result.content).startsWith(incomplete)).toBe(true);
    const untruncated = fixture([]);
    const logs = await untruncated.tool.execute({ source: `console.log(${JSON.stringify(incomplete)}); return "done"` }, untruncated.context);
    expect(logs.content).toBe(`done\n\nLogs:\n${incomplete}`);
  });

  it("does not let a nested END expose a truncated console private-key body at any flush", async () => {
    const begin = `-----BEGIN ${"RSA PRIVATE KEY"}-----`;
    const end = `-----END ${"RSA PRIVATE KEY"}-----`;
    const body = "console-private-body";
    const nested = runtimeTool("read", async () => ({ content: "ok", outcome: "ok" }));
    nested.inputSchema = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
    const run = fixture([nested], { maxLogBytes: Buffer.byteLength(`${begin}\n${body}\n`) });
    const timers = captureLogTimers();
    try {
      const result = await run.tool.execute({
        source: `console.log(${JSON.stringify(begin)}); await tools.read({text: ${JSON.stringify(end)}}); console.log(${JSON.stringify(body)}); console.log(${JSON.stringify(end)}); return "full-return"`,
      }, run.context);
      for (const output of run.outputs) expect(output).not.toContain(body);
      const row = `-> tools.read ${JSON.stringify({ text: end })}`;
      expect(run.outputs).toEqual([
        `${begin}\n${row}`,
        `[redacted secret]\n${row}\n\n`,
      ]);
      expect(result.content).toBe("full-return\n\nLogs:\n[redacted secret]");
      expect(timers.callbacks.size).toBe(0);
      timers.tick();
      expect(run.outputs).toHaveLength(2);
    } finally {
      timers.restore();
    }
  });

  it("keeps incomplete untruncated console text when only nested previews overflow", async () => {
    const incomplete = `-----BEGIN ${"PRIVATE KEY"}-----\nordinary-incomplete-body`;
    const nested = runtimeTool("read", async () => ({ content: "ok", outcome: "ok" }));
    nested.inputSchema = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
    const run = fixture([nested]);
    const result = await run.tool.execute({
      source: `console.log(${JSON.stringify(incomplete)}); await tools.read({text: "x".repeat(50 * 1024)}); console.log("tail"); return "done"`,
    }, run.context);
    const notice = "[1 additional nested input previews omitted]";
    expect(run.outputs).toEqual([`${incomplete}\n${notice}`, `${incomplete}\ntail\n${notice}`]);
    expect(result.content).toBe(`done\n\nLogs:\n${incomplete}\ntail`);
  });

  it("keeps nested rows between original multiline and empty console entries after redaction", async () => {
    const begin = `-----BEGIN ${"PRIVATE KEY"}-----`;
    const end = `-----END ${"PRIVATE KEY"}-----`;
    const first = `before\n${begin}\nprivate-first\n`;
    const last = `private-last\n${end}\nafter\n`;
    const run = fixture([runtimeTool("read", async () => ({ content: "ok", outcome: "ok" }))]);
    const result = await run.tool.execute({
      source: `console.log(${JSON.stringify(first)}); await tools.read({}); console.log(""); await tools.read({}); console.log(${JSON.stringify(last)}); console.log(""); return "done"`,
    }, run.context);
    expect(run.outputs.at(-1)).toBe([
      "before\n[redacted secret]\n\n",
      "-> tools.read {}",
      "",
      "-> tools.read {}",
      "\n\nafter\n",
      "",
    ].join("\n"));
    expect(result.content).toBe("done\n\nLogs:\nbefore\n[redacted secret]\nafter\n\n");
  });

  it("refuses unresolved names with the host's callable-map diagnostic", async () => {
    const run = fixture([]);
    const result = await run.tool.execute({ source: "return await tools.missing({})" }, run.context);

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("Unknown tool 'missing'");
    expect(result.content).toContain("not registered in the current session");
    expect(run.facts).toEqual(["validation:outer#1"]);
    expect(result.details).toBeUndefined();
  });

  it("appends warnings and logs as labelled sections", async () => {
    const run = fixture([]);
    const result = await run.tool.execute({ source: 'console.log("observed"); Promise.reject(new Error("boom")); return "done"' }, run.context);

    expect(result.content).toBe("done\n\nWarnings:\n- [ExecutionFailure] Unhandled rejection from an un-awaited promise: Uncaught: boom\n\nLogs:\nobserved");
    expect(result.details).toBeUndefined();
  });

  it("executes sequential and parallel nested calls with ordinary child evidence", async () => {
    let calls = 0;
    const nested = runtimeTool("read", async () => ({ content: `value-${++calls}`, outcome: "ok" }));
    const sequential = fixture([nested]);
    const first = await sequential.tool.execute({ source: "const a = await tools.read({}); const b = await tools.read({}); return [a, b]" }, sequential.context);
    expect(first.outcome).toBe("ok");
    expect(JSON.parse(String(first.content))).toEqual([
      { outcome: "ok", content: "value-1" },
      { outcome: "ok", content: "value-2" },
    ]);
    expect(sequential.facts).toEqual(["input:outer#1", "result:outer#1:ok", "input:outer#2", "result:outer#2:ok"]);

    const parallel = fixture([nested]);
    const second = await parallel.tool.execute({ source: "return await Promise.all([tools.read({}), tools.read({})])" }, parallel.context);
    expect(second.outcome).toBe("ok");
    expect(parallel.facts.filter((fact) => fact.startsWith("result:"))).toHaveLength(2);
  });

  it("streams deeply redacted nested-start breadcrumbs only through cumulative parent output", async () => {
    const nested = runtimeTool("context7.resolve-library-id", async () => ({ content: "done", outcome: "ok" }));
    nested.inputSchema = { type: "object", properties: { nested: { type: "object" } }, required: ["nested"] };
    const run = fixture([nested]);
    const secret = ["Bearer", "fixturevalue123"].join(" ");
    await run.tool.execute({ source: `return await Promise.all([tools.context7["resolve-library-id"]({ nested: { token: "${secret}" } }), tools.context7["resolve-library-id"]({ nested: { token: "safe" } })])` }, run.context);

    expect(run.outputs).toHaveLength(2);
    expect(run.outputs[0]).toBe('-> tools.context7["resolve-library-id"] {"nested":{"token":"[redacted secret]"}}');
    expect(run.outputs[1]).toBe('-> tools.context7["resolve-library-id"] {"nested":{"token":"[redacted secret]"}}\n-> tools.context7["resolve-library-id"] {"nested":{"token":"safe"}}');
    expect(run.outputs.join("\n")).not.toContain(secret);
    expect(run.facts.some((fact) => fact.startsWith("output:"))).toBe(false);
  });

  it("interleaves small nested rows at retained console positions and keeps terminal logs console-only", async () => {
    const run = fixture([runtimeTool("read", async () => ({ content: "ok", outcome: "ok" }))]);
    const result = await run.tool.execute({
      source: `console.log("before"); await tools.read({}); console.log("between"); await tools.read({}); console.log("after"); return "done"`,
    }, run.context);
    expect(run.outputs).toEqual([
      "before\n-> tools.read {}",
      "before\n-> tools.read {}\nbetween\n-> tools.read {}",
      "before\n-> tools.read {}\nbetween\n-> tools.read {}\nafter",
    ]);
    expect(result.content).toBe("done\n\nLogs:\nbefore\nbetween\nafter");
  });

  it("publishes count-only feedback immediately on every nested start after prefix saturation", async () => {
    let started = 0;
    const atStart: string[] = [];
    const nested = runtimeTool("read", async () => {
      started++;
      atStart.push(run.outputs.at(-1)!);
      return { content: "ok", outcome: "ok" };
    });
    nested.inputSchema = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
    const run = fixture([nested]);
    const result = await run.tool.execute({
      source: `await tools.read({text: "a".repeat(30_000)}); await tools.read({text: "b".repeat(30_000)}); await tools.read({text: "later-small"}); await tools.read({text: "last"}); return "done"`,
    }, run.context);
    expect(started).toBe(4);
    expect(run.outputs).toEqual(atStart);
    for (let index = 1; index < 4; index++) expect(atStart[index]).toContain(`[${index} additional nested input previews omitted]`);
    expect(result.content).toBe("done");
    expect(run.outputs[0]).toBe(`-> tools.read {"text":"${"a".repeat(30_000)}"}`);
    for (const output of run.outputs) {
      expect(Buffer.byteLength(output)).toBeLessThan(50 * 1024 + 100);
      expect(output).not.toContain("later-small");
      expect(output).not.toContain('"last"');
      expect(output).not.toContain("bbb");
    }
  });

  it("redacts each complete incoming nested row before applying the whole-row budget", async () => {
    const run = fixture([runtimeTool("read", async () => ({ content: "ok", outcome: "ok" }))]);
    const begin = `-----BEGIN ${"PRIVATE KEY"}-----`;
    const end = `-----END ${"PRIVATE KEY"}-----`;
    const inner = run.context.createNestedToolDispatchBatch!;
    run.context.createNestedToolDispatchBatch = (options) => inner({
      ...options,
      onNestedStart: () => options.onNestedStart?.(`-> fixture ${begin}\n${"private-body".repeat(6_000)}\n${end}`),
    });
    await run.tool.execute({ source: "await tools.read({}); await tools.read({}); return 1" }, run.context);
    expect(run.outputs).toEqual(["-> fixture [redacted secret]", "-> fixture [redacted secret]\n-> fixture [redacted secret]"]);
  });

  it("relays a nested image on the outer result", async () => {
    const image = runtimeTool("image", async () => ({
      outcome: "ok",
      content: [{ type: "text", text: "caption" }, { type: "image", mediaType: "image/png", data: "aGk=" }],
    }));
    const run = fixture([image]);
    const result = await run.tool.execute({ source: "return await tools.image({})" }, run.context);

    expect(result.content).toEqual([
      { type: "text", text: '{\n  "outcome": "ok",\n  "content": "caption"\n}' },
      { type: "image", mediaType: "image/png", data: "aGk=" },
    ]);
  });

  it("relays concurrent nested images in invocation order", async () => {
    const deferred = (result: ToolResult) => ({ ...Promise.withResolvers<ToolResult>(), result });
    const first = deferred({ outcome: "ok", content: [
      { type: "image", mediaType: "image/png", data: "first-a" },
      { type: "image", mediaType: "image/png", data: "first-b" },
    ] });
    const second = deferred({ outcome: "ok", content: [
      { type: "image", mediaType: "image/png", data: "second-a" },
      { type: "image", mediaType: "image/png", data: "second-b" },
    ] });
    let secondInvoked!: () => void;
    const secondInvocation = new Promise<void>((resolve) => { secondInvoked = resolve; });
    const run = fixture([
      runtimeTool("first", () => first.promise),
      runtimeTool("second", () => { secondInvoked(); return second.promise; }),
    ]);

    const execution = run.tool.execute({ source: "return await Promise.all([tools.first({}), tools.second({})])" }, run.context);
    await secondInvocation;
    second.resolve(second.result);
    await Promise.resolve();
    first.resolve(first.result);
    const result = await execution;

    expect(result.content).toEqual([
      { type: "text", text: "[\n  {\n    \"outcome\": \"ok\",\n    \"content\": \"\"\n  },\n  {\n    \"outcome\": \"ok\",\n    \"content\": \"\"\n  }\n]" },
      { type: "image", mediaType: "image/png", data: "first-a" },
      { type: "image", mediaType: "image/png", data: "first-b" },
      { type: "image", mediaType: "image/png", data: "second-a" },
      { type: "image", mediaType: "image/png", data: "second-b" },
    ]);
  });

  it("parses JSON-document text for the script and redacts after parsing", async () => {
    const run = async (content: string) => {
      const nested = fixture([runtimeTool("fetch", async () => ({ outcome: "ok", content }))]);
      const result = await nested.tool.execute({ source: "const { content } = await tools.fetch({}); return { kind: typeof content, content }" }, nested.context);
      return JSON.parse(String(result.content));
    };
    expect(await run('{"issues":[{"id":1}]}')).toEqual({ kind: "object", content: { issues: [{ id: 1 }] } });
    expect(await run("plain text")).toEqual({ kind: "string", content: "plain text" });
    expect(await run("{not json")).toEqual({ kind: "string", content: "{not json" });
    // The \u0020 escape hides the Bearer pattern from a text-level redactor.
    expect(await run('{"token":"Bearer\\u0020abcdefghijklmnop"}')).toEqual({ kind: "object", content: { token: "[redacted secret]" } });
  });

  it("counts relayed image data against the aggregate budget", async () => {
    const run = fixture([runtimeTool("image", async () => ({ outcome: "ok", content: [{ type: "image", mediaType: "image/png", data: "aGk=" }] }))], { maxAggregateResultBytes: 4 });
    const result = await run.tool.execute({ source: "await tools.image({}); return await tools.image({})" }, run.context);
    // The first image fits the budget and stays on the result; the second is refused.
    const [text, ...images] = Array.isArray(result.content) ? result.content : [];
    expect(result.outcome).toBe("error");
    expect(text?.type === "text" ? text.text : "").toContain("Nested tool results exceeded the 4-byte aggregate limit");
    expect(images).toEqual([{ type: "image", mediaType: "image/png", data: "aGk=" }]);
    expect(run.facts.filter((fact) => fact.startsWith("result:"))).toHaveLength(2);
  });

  it("keeps unknown names and non-object inputs refused at the shared boundary", async () => {
    let dispatched = 0;
    const replies: unknown[] = [];
    const guest = () => scriptedWorker((message, worker) => {
      if (message.type === "start") {
        worker.send({ type: "call", id: 0, name: "other.secret", input: {} });
        worker.send({ type: "call", id: 1, name: "own", input: "not an object" });
      }
      if (message.type !== "call-result") return;
      replies.push(message.reply);
      if (replies.length === 2) worker.send({ type: "result", outcome: "ok", text: "done", ending: "returned" });
    });
    const service = codeModeService({ openWorker: guest });
    const own = runtimeTool("own", async () => { dispatched++; return { outcome: "ok", content: "unused" }; });
    const sibling = runtimeTool("other.secret", async () => { dispatched++; return { outcome: "ok", content: "unused" }; });
    // The sibling request plans its own map from the same service; this one never holds it.
    codeToolOver(new Map([[sibling.name, sibling]]), service);
    const run = fixture([own], {}, service);
    expect(await run.tool.execute({ source: "unused by the scripted guest" }, run.context)).toEqual({ outcome: "ok", content: "done" });
    expect(replies).toEqual([
      { kind: "refused", message: expect.stringContaining("Unknown tool 'other.secret'") },
      { kind: "ok", outcome: "error", content: expect.stringContaining("not an object") },
    ]);
    expect(dispatched).toBe(0);
    expect(run.facts).toEqual(["validation:outer#1", "validation:outer#2"]);
  });

  it("lets a nested name repair and JSON-text input reach the shared dispatcher", async () => {
    const inputs: unknown[] = [];
    const read = runtimeTool("demo.lookup", async input => { inputs.push(input); return { content: "ran", outcome: "ok" }; });
    read.inputSchema = { type: "object", properties: { count: { type: "number" } }, required: ["count"] };
    const run = fixture([read]);
    const result = await run.tool.execute({ source: `return await tools.demo.Lookup('{"count":"2"}')` }, run.context);
    expect(result.outcome).toBe("ok");
    const reply = JSON.parse(String(result.content));
    expect(reply.outcome).toBe("ok");
    expect(reply.content).toContain("Note: the text value of `input` was read as an object.");
    expect(reply.content).toContain("tool 'demo.Lookup' was read as 'demo.lookup'");
    expect(inputs).toEqual([{ count: 2 }]);
    expect(run.facts).toEqual(["input:outer#1", "result:outer#1:ok"]);
    read.execute = async () => ({ outcome: "error", content: "EXPECTED FAILURE" });
    for (const name of ["lookup", "Lookup"]) {
      const failure = await run.tool.execute({
        source: `const r = await tools.demo.${name}({ count: 2 }); return { handled: r.outcome === "error", content: r.content }`,
      }, run.context);
      expect(failure.outcome).toBe("ok");
      const value = JSON.parse(String(failure.content));
      expect(value.handled).toBe(true);
      expect(value.content).toContain("EXPECTED FAILURE");
      if (name === "Lookup") expect(value.content).toStartWith("Note: tool 'demo.Lookup' was read as 'demo.lookup'.");
      else expect(value.content).toBe("EXPECTED FAILURE");
    }
  });

  it("enforces call, aggregate, and timeout limits as diagnostics", async () => {
    let calls = 0;
    const nested = runtimeTool("read", async () => ({ content: "payload", outcome: "ok" }));
    nested.execute = async () => { calls += 1; return { content: "payload", outcome: "ok" }; };
    const capped = fixture([nested], { maxToolCalls: 2, maxAggregateResultBytes: 100, timeoutMs: 1000 });
    const result = await capped.tool.execute({ source: "await tools.read({}); await tools.read({}); return await tools.read({})" }, capped.context);
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("Execution exceeded its tool-call limit of 2.");
    expect(calls).toBe(2);

    const aggregate = fixture([nested], { maxAggregateResultBytes: 3 });
    const aggregateResult = await aggregate.tool.execute({ source: "return await tools.read({})" }, aggregate.context);
    expect(aggregateResult.outcome).toBe("error");
    expect(String(aggregateResult.content)).toContain("aggregate limit");

    const timeout = fixture([], { timeoutMs: 1 });
    const timeoutResult = await timeout.tool.execute({ source: "while (true) {}" }, timeout.context);
    expect(timeoutResult.outcome).toBe("error");
    expect(timeoutResult.content).toContain("Execution timed out after 1ms.");
  });

  it("names the nested calls still running when the program ends", async () => {
    // The guest calls `done`, then `demo.pending`, and ends once the second call runs.
    const guest = scriptedWorker((message, worker) => {
      if (message.type === "start") worker.send({ type: "call", id: 0, name: "done", input: {} });
      if (message.type === "call-result") worker.send({ type: "call", id: 1, name: "demo.pending", input: {} });
    });
    const run = fixture([
      runtimeTool("done", async () => ({ content: "ok", outcome: "ok" })),
      runtimeTool("demo.pending", async (_input, context) => {
        guest.send({ type: "result", outcome: "ok", text: "returned", ending: "returned" });
        await new Promise((resolve) => context.signal?.addEventListener("abort", resolve, { once: true }));
        return { content: "stopped", outcome: "interrupted" };
      }),
    ], {}, codeModeService({ openWorker: () => guest }));
    const result = await run.tool.execute({ source: "unused by the scripted guest" }, run.context);
    expect(result).toEqual({
      outcome: "ok",
      content: "returned\nCalls still running when the program ended, whose effects may have completed: demo.pending. Check their effects before you run them again.",
    });
  });

  it("completes normally while the heap watchdog races", async () => {
    const run = fixture([], { maxHeapDeltaBytes: 8 * 1024 * 1024, heapSampleMs: 5 });
    const result = await run.tool.execute({ source: "return [1, 2, 3].map((value) => value * 2)" }, run.context);

    expect(result.outcome).toBe("ok");
    expect(JSON.parse(String(result.content))).toEqual([2, 4, 6]);
  });

  it("publishes cumulative log snapshots and flushes the final tail once", async () => {
    const run = fixture([]);
    const source = `${Array.from({ length: 65 }, (_, index) => `console.log("line-${index}")`).join(";")}; return "done"`;
    const result = await run.tool.execute({ source }, run.context);
    expect(result.outcome).toBe("ok");
    expect(run.outputs).toHaveLength(1);
    expect(run.outputs[0]?.split("\n")).toHaveLength(65);
    expect(run.outputs[0]).toContain("line-64");
  });

  it("coalesces logs on the trailing timer and cancels the final timer with no after-close output", async () => {
    const timers = captureLogTimers();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const run = fixture([runtimeTool("pause", async () => {
      started.resolve();
      await release.promise;
      return { content: "ok", outcome: "ok" };
    })]);
    const inner = run.context.createNestedToolDispatchBatch!;
    run.context.createNestedToolDispatchBatch = (options) => inner({ ...options, onNestedStart: () => {} });
    try {
      const execution = run.tool.execute({
        source: `const pending = tools.pause({}); for (let i = 0; i < 65; i++) console.log("line", i); await pending; console.log("tail"); return "done"`,
      }, run.context);
      await started.promise;
      // Let the guest reach its explicit await without advancing the captured timer.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(run.outputs).toEqual([]);
      expect(timers.callbacks.size).toBe(1);
      timers.tick();
      expect(run.outputs).toHaveLength(1);
      expect(run.outputs[0]).toContain("line 64");
      release.resolve();
      await execution;
      expect(run.outputs).toHaveLength(2);
      expect(run.outputs[1]).toEndWith("tail");
      expect(timers.callbacks.size).toBe(0);
      timers.tick();
      expect(run.outputs).toHaveLength(2);
    } finally {
      release.resolve();
      timers.restore();
    }
  });

  it("uses fresh interpreter state for each call", async () => {
    const run = fixture([]);
    const first = await run.tool.execute({ source: "globalCounter = 1; return globalCounter" }, run.context);
    const second = await run.tool.execute({ source: "return typeof globalCounter" }, run.context);
    expect(first.outcome).toBe("error");
    expect(second.content).toBe("undefined");
  });

  it("records bounded burst memory evidence", async () => {
    const nested = runtimeTool("read", async () => ({ content: "x".repeat(1_024), outcome: "ok" }));
    const before = process.memoryUsage().heapUsed;
    const run = fixture([nested]);
    const result = await run.tool.execute({ source: `return await Promise.all([${Array.from({ length: 50 }, () => "tools.read({})").join(",")}])` }, run.context);
    const peakDelta = process.memoryUsage().heapUsed - before;
    expect(result.outcome).toBe("ok");
    expect(run.facts.filter((fact) => fact.startsWith("result:"))).toHaveLength(50);
    expect(Number.isFinite(peakDelta)).toBe(true);
  });

  it("redacts outer source, logs, result values, and details", async () => {
    const run = fixture([]);
    const secret = ["Bearer", "fixturevalue123"].join(" ");
    const result = await run.tool.execute({ source: `console.log("${secret}"); return "${secret}"` }, run.context);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(run.outputs.join("\n")).not.toContain(secret);
    expect(JSON.stringify(result)).toContain("[redacted secret]");
  });

  it("closes the log publisher even when the nested batch close rejects", async () => {
    const timers = captureLogTimers();
    const run = fixture([]);
    const inner = run.context.createNestedToolDispatchBatch;
    run.context.createNestedToolDispatchBatch = (options) => {
      const batch = inner!(options);
      return { ...batch, close: () => Effect.die(new Error("terminal publication failed")) };
    };

    try {
      await expect(run.tool.execute({ source: 'console.log("buffered"); return 1' }, run.context)).rejects.toThrow("terminal publication failed");
      expect(run.outputs).toEqual(["buffered"]);
      expect(timers.callbacks.size).toBe(0);
      timers.tick();
      expect(run.outputs).toEqual(["buffered"]);
    } finally {
      timers.restore();
    }
  });
});
