import { describe, expect, it } from "bun:test";

import * as os from "node:os";
import * as path from "node:path";
import { rmSync } from "node:fs";

import { createSubagentTool, type SubagentToolDeps } from "../src/orchestration/engines/providers/harness/tools/subagent.js";
import type { AgentDefinition } from "../src/orchestration/engines/providers/harness/agent-loader.js";
import type { LLMClient } from "../src/orchestration/engines/providers/harness/llm/types.js";
import type { NDJSONEvent } from "../src/infra/ndjson-event-types.js";
import type { ToolContext } from "../src/orchestration/engines/providers/harness/tools/types.js";
import type { EngineResult, EngineRunner, RunnerOptions } from "../src/orchestration/engines/core/types.js";
import { parsePersonaFile } from "../src/orchestration/engines/providers/harness/agent-loader.js";
import { createNDJSONEvent } from "../src/infra/ndjson-event-factory.js";

const EXPLORER_PERSONA = `---
name: explorer
description: "Fast read-only codebase investigation."
tier: cheap
tools: [read, text_search, bash]
maxTurns: 30
---
You are a focused codebase investigator.`;

const WORKER_PERSONA = `---
name: worker
description: "General-purpose implementation."
tier: powerful
tools: [read, text_search, bash, edit, write, todo_list]
maxTurns: 100
---
You are a task execution agent.`;

function buildRegistry(): Map<string, AgentDefinition> {
  const registry = new Map<string, AgentDefinition>();
  registry.set("explorer", parsePersonaFile(EXPLORER_PERSONA));
  registry.set("worker", parsePersonaFile(WORKER_PERSONA));
  return registry;
}

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    cwd: os.tmpdir(),
    todoList: [],
    readFiles: new Set(),
    bgLogPaths: new Set(),
    ...overrides,
  };
}

function makeMockClient(): LLMClient {
  return {
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model: "claude-haiku-4-5-20251001",
    contextLimit: 200_000,
    outputLimit: 8_192,
    supportsReasoning: false,
    async *streamWithTools() { yield { kind: "done" as const, stopReason: "end_turn" }; },
    async complete() { return ""; },
    costFor() { return 0.001; },
  };
}

interface MockRunnerCall {
  options: RunnerOptions;
  modelUsedForClient: string;
}

function makeMockRunnerFactory(opts?: {
  finalText?: string;
  shouldThrow?: boolean;
  totalCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  emitToolResult?: { toolUseId: string; content: string };
}) {
  const calls: MockRunnerCall[] = [];

  const factory = (options: RunnerOptions, clientFactory: (model: string) => LLMClient): EngineRunner => {
    clientFactory(options.model);
    calls.push({ options, modelUsedForClient: options.model });

    const parentToolUseId = options.parentToolUseId;

    const { promise, resolve, reject } = Promise.withResolvers<EngineResult>();

    return {
      send(_text: string): void {
        setTimeout(() => {
          try {
            if (opts?.shouldThrow) {
              reject(new Error("LLM connection failed"));
              return;
            }

            if (opts?.emitToolResult) {
              options.onEvent(createNDJSONEvent("tool_result", {
                type: "tool_result",
                tool_use_id: opts.emitToolResult.toolUseId,
                content: opts.emitToolResult.content,
                is_error: false,
                ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
              }));
            }

            if (opts?.finalText) {
              options.onEvent(createNDJSONEvent("assistant", {
                type: "assistant",
                message: {
                  content: [{ type: "text", text: opts.finalText }],
                  usage: { input_tokens: opts?.inputTokens ?? 100 },
                  ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
                },
              }));
            }

            options.onEvent(createNDJSONEvent("result", {
              type: "result",
              subtype: "success",
              session_id: "harness-mock",
              total_cost_usd: opts?.totalCostUsd ?? 0.001,
              usage: {
                input_tokens: opts?.inputTokens ?? 100,
                output_tokens: opts?.outputTokens ?? 50,
              },
              ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
            }));

            resolve({ durationMs: 1, sessionId: "harness-mock" });
          } catch (err) {
            reject(err);
          }
        }, 0);
      },
      end() {},
      abort() {},
      drainPendingInputs() { return []; },
      done: promise,
    };
  };

  return { factory, calls };
}

function makeDeps(overrides?: Partial<SubagentToolDeps>): SubagentToolDeps {
  return {
    agentRegistry: buildRegistry(),
    createLLMClient: () => makeMockClient(),
    modelFamily: "anthropic",
    parentModel: "claude-opus-4-7",
    onRenderEvent: () => {},
    addCost: () => {},
    projectInstructions: "Project instructions here.",
    sessionDir: path.join(os.tmpdir(), `subagent-test-${Date.now()}`),
    ...overrides,
  };
}

describe("subagent tool", () => {
  describe("agent registry", () => {
    it("returns correct definition for explorer", () => {
      const registry = buildRegistry();
      const explorer = registry.get("explorer");
      expect(explorer).toBeDefined();
      expect(explorer!.name).toBe("explorer");
      expect(explorer!.defaultTier).toBe("cheap");
      expect(explorer!.tools).toContain("read");
      expect(explorer!.tools).toContain("bash");
    });

    it("returns undefined for nonexistent agent", () => {
      const registry = buildRegistry();
      expect(registry.get("nonexistent")).toBeUndefined();
    });

    it("no agent tools list contains subagent (recursion prevention)", () => {
      const registry = buildRegistry();
      for (const [, agent] of registry) {
        expect(agent.tools).not.toContain("subagent");
      }
    });
  });

  describe("createSubagentTool", () => {
    it("produces a ToolDefinition with correct name and schema", () => {
      const deps = makeDeps();
      const tool = createSubagentTool(deps);

      expect(tool.name).toBe("subagent");
      expect(tool.description).toContain("explorer");
      expect(tool.description).toContain("worker");
      expect(tool.description).toContain("subagent");

      const schema = tool.input_schema as { required: string[]; properties: Record<string, unknown> };
      expect(schema.required).toContain("subagent_type");
      expect(schema.required).toContain("prompt");
      expect(schema.properties.tier).toBeDefined();
    });

    it("description includes agent details from registry", () => {
      const deps = makeDeps();
      const tool = createSubagentTool(deps);

      expect(tool.description).toContain("explorer");
      expect(tool.description).toContain("cheap");
      expect(tool.description).toContain("read-only");
      expect(tool.description).toContain("worker");
      expect(tool.description).toContain("powerful");
    });
  });

  describe("execute", () => {
    it("returns error for unknown subagent_type", async () => {
      const deps = makeDeps();
      const tool = createSubagentTool(deps);
      const ctx = makeContext();

      const result = await tool.execute({ subagent_type: "nonexistent", prompt: "do stuff" }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Unknown subagent_type 'nonexistent'");
      expect(result.content).toContain("explorer");
    });

    it("returns error for missing subagent_type", async () => {
      const deps = makeDeps();
      const tool = createSubagentTool(deps);
      const ctx = makeContext();

      const result = await tool.execute({ prompt: "do stuff" }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("subagent_type");
    });

    it("returns error for missing prompt", async () => {
      const deps = makeDeps();
      const tool = createSubagentTool(deps);
      const ctx = makeContext();

      const result = await tool.execute({ subagent_type: "explorer" }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("prompt");
    });

    it("returns error for invalid tier", async () => {
      const deps = makeDeps();
      const tool = createSubagentTool(deps);
      const ctx = makeContext();

      const result = await tool.execute({ subagent_type: "explorer", prompt: "do stuff", tier: "ultra" }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Invalid tier 'ultra'");
    });

    it("constructs runner with correct options", async () => {
      const { factory, calls } = makeMockRunnerFactory({ finalText: "Found the answer." });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const deps = makeDeps({ sessionDir, _createRunner: factory });
      const tool = createSubagentTool(deps);
      const ctx = makeContext({ cwd: "/test/cwd", toolCallId: "tc_123" });

      await tool.execute({ subagent_type: "explorer", prompt: "find the config" }, ctx);

      expect(calls.length).toBe(1);
      const opts = calls[0]!.options;
      expect(opts.cwd).toBe("/test/cwd");
      expect(opts.maxLLMCalls).toBe(30);
      expect(opts.parentToolUseId).toBe("tc_123");
      expect(opts.systemPrompt).toBe("You are a focused codebase investigator.");
      expect(opts.projectInstructions).toBe("Project instructions here.");
      expect(opts.engineToolNames).toEqual(["read", "text_search", "bash"]);

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("sends the prompt verbatim to the runner", async () => {
      const { factory } = makeMockRunnerFactory({ finalText: "done" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);

      let sentPrompt: string | undefined;
      const wrappedFactory: typeof factory = (opts, clientFactory) => {
        const runner = factory(opts, clientFactory);
        const origSend = runner.send.bind(runner);
        return {
          ...runner,
          send: (text: string) => {
            sentPrompt = text;
            origSend(text);
          },
        };
      };

      const deps = makeDeps({ sessionDir, _createRunner: wrappedFactory });
      const tool = createSubagentTool(deps);
      const ctx = makeContext();

      await tool.execute({ subagent_type: "explorer", prompt: "find the config" }, ctx);
      expect(sentPrompt).toBe("find the config");

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("returns final assistant text as result", async () => {
      const { factory } = makeMockRunnerFactory({ finalText: "The config is at src/config.ts" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const deps = makeDeps({ sessionDir, _createRunner: factory });
      const tool = createSubagentTool(deps);
      const ctx = makeContext();

      const result = await tool.execute({ subagent_type: "explorer", prompt: "find config" }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toBe("The config is at src/config.ts");

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("returns fallback message when no text output", async () => {
      const { factory } = makeMockRunnerFactory();
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const deps = makeDeps({ sessionDir, _createRunner: factory });
      const tool = createSubagentTool(deps);
      const ctx = makeContext();

      const result = await tool.execute({ subagent_type: "explorer", prompt: "find config" }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toContain("completed without producing text output");

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("tier override resolves correctly", async () => {
      let resolvedModel = "";
      const { factory } = makeMockRunnerFactory({ finalText: "done" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const deps = makeDeps({
        sessionDir,
        createLLMClient: (model: string) => {
          resolvedModel = model;
          return makeMockClient();
        },
        _createRunner: factory,
      });
      const tool = createSubagentTool(deps);
      const ctx = makeContext();

      await tool.execute({ subagent_type: "explorer", prompt: "find stuff", tier: "powerful" }, ctx);
      expect(resolvedModel).toContain("opus");

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("addCost called once after completion with totals from the runner's result event", async () => {
      const costCalls: Array<{ cost: number; input: number; output: number }> = [];
      const { factory } = makeMockRunnerFactory({
        finalText: "result",
        totalCostUsd: 0.05,
        inputTokens: 250,
        outputTokens: 125,
      });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const deps = makeDeps({
        sessionDir,
        addCost: (cost, input, output) => costCalls.push({ cost, input, output }),
        _createRunner: factory,
      });
      const tool = createSubagentTool(deps);
      const ctx = makeContext();

      await tool.execute({ subagent_type: "explorer", prompt: "search" }, ctx);
      expect(costCalls.length).toBe(1);
      expect(costCalls[0]!.cost).toBeCloseTo(0.05, 10);
      expect(costCalls[0]!.input).toBe(250);
      expect(costCalls[0]!.output).toBe(125);

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("addCost called even on failure", async () => {
      const costCalls: Array<{ cost: number; input: number; output: number }> = [];
      const { factory } = makeMockRunnerFactory({ shouldThrow: true });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const deps = makeDeps({
        sessionDir,
        addCost: (cost, input, output) => costCalls.push({ cost, input, output }),
        _createRunner: factory,
      });
      const tool = createSubagentTool(deps);
      const ctx = makeContext();

      const result = await tool.execute({ subagent_type: "explorer", prompt: "search" }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("failed");
      expect(costCalls.length).toBe(1);

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("onRenderEvent receives assistant events with parent_tool_use_id on the message", async () => {
      const renderedEvents: NDJSONEvent[] = [];
      const { factory } = makeMockRunnerFactory({ finalText: "answer" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const deps = makeDeps({
        sessionDir,
        onRenderEvent: (event) => renderedEvents.push(event),
        _createRunner: factory,
      });
      const tool = createSubagentTool(deps);
      const ctx = makeContext({ toolCallId: "tc_parent_456" });

      await tool.execute({ subagent_type: "explorer", prompt: "investigate" }, ctx);

      const assistantEvents = renderedEvents.filter(e => e.type === "assistant");
      expect(assistantEvents.length).toBeGreaterThan(0);
      for (const evt of assistantEvents) {
        expect(evt.data.message?.parent_tool_use_id).toBe("tc_parent_456");
      }

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("onRenderEvent never receives result events", async () => {
      const renderedEvents: NDJSONEvent[] = [];
      const { factory } = makeMockRunnerFactory({ finalText: "answer" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const deps = makeDeps({
        sessionDir,
        onRenderEvent: (event) => renderedEvents.push(event),
        _createRunner: factory,
      });
      const tool = createSubagentTool(deps);
      const ctx = makeContext();

      await tool.execute({ subagent_type: "explorer", prompt: "investigate" }, ctx);

      const resultEvents = renderedEvents.filter(e => e.type === "result");
      expect(resultEvents.length).toBe(0);

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("onRenderEvent never receives content_block_delta events", async () => {
      const renderedEvents: NDJSONEvent[] = [];
      const { factory } = makeMockRunnerFactory({ finalText: "answer" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);

      // Wrap factory to inject a content_block_delta event alongside the expected ones.
      const wrappedFactory: typeof factory = (opts, clientFactory) => {
        const runner = factory(opts, clientFactory);
        const origSend = runner.send.bind(runner);
        return {
          ...runner,
          send: (text: string) => {
            opts.onEvent(createNDJSONEvent("content_block_delta", {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "delta" },
              ...(opts.parentToolUseId ? { parent_tool_use_id: opts.parentToolUseId } : {}),
            }));
            origSend(text);
          },
        };
      };

      const deps = makeDeps({
        sessionDir,
        onRenderEvent: (event) => renderedEvents.push(event),
        _createRunner: wrappedFactory,
      });
      const tool = createSubagentTool(deps);
      const ctx = makeContext();

      await tool.execute({ subagent_type: "explorer", prompt: "investigate" }, ctx);

      const deltaEvents = renderedEvents.filter(e => e.type === "content_block_delta");
      expect(deltaEvents.length).toBe(0);

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("creates subagents directory in sessionDir", async () => {
      const { factory } = makeMockRunnerFactory({ finalText: "done" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-dir-${Date.now()}`);
      const deps = makeDeps({
        sessionDir,
        _createRunner: factory,
      });
      const tool = createSubagentTool(deps);
      const ctx = makeContext();

      await tool.execute({ subagent_type: "explorer", prompt: "look" }, ctx);

      const { existsSync } = await import("node:fs");
      expect(existsSync(path.join(sessionDir, "subagents"))).toBe(true);

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("conversationPath resolver points at subagents/<toolCallId>.jsonl", async () => {
      const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const deps = makeDeps({
        sessionDir,
        _createRunner: factory,
      });
      const tool = createSubagentTool(deps);
      const ctx = makeContext({ toolCallId: "tc_abc" });

      await tool.execute({ subagent_type: "explorer", prompt: "look" }, ctx);

      const resolver = calls[0]!.options.conversationPath;
      expect(typeof resolver).toBe("function");
      const resolved = typeof resolver === "function" ? resolver("harness-any") : resolver;
      expect(resolved).toBe(path.join(sessionDir, "subagents", "tc_abc.jsonl"));

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("uses agent default tier when no tier override", async () => {
      let resolvedModel = "";
      const { factory } = makeMockRunnerFactory({ finalText: "done" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const deps = makeDeps({
        sessionDir,
        createLLMClient: (model: string) => {
          resolvedModel = model;
          return makeMockClient();
        },
        _createRunner: factory,
      });
      const tool = createSubagentTool(deps);
      const ctx = makeContext();

      await tool.execute({ subagent_type: "explorer", prompt: "find stuff" }, ctx);
      expect(resolvedModel).toContain("haiku");

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("worker agent gets full tool set and its own maxTurns", async () => {
      const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const deps = makeDeps({
        sessionDir,
        _createRunner: factory,
      });
      const tool = createSubagentTool(deps);
      const ctx = makeContext();

      await tool.execute({ subagent_type: "worker", prompt: "implement feature" }, ctx);

      const opts = calls[0]!.options;
      expect(opts.engineToolNames).toContain("edit");
      expect(opts.engineToolNames).toContain("write");
      expect(opts.engineToolNames).toContain("todo_list");
      expect(opts.maxLLMCalls).toBe(100);

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("passes empty agentRegistry to prevent nested subagent recursion", async () => {
      const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const deps = makeDeps({
        sessionDir,
        _createRunner: factory,
      });
      const tool = createSubagentTool(deps);
      const ctx = makeContext();

      await tool.execute({ subagent_type: "explorer", prompt: "look" }, ctx);

      const opts = calls[0]!.options;
      expect(opts.agentRegistry).toBeDefined();
      expect(opts.agentRegistry!.size).toBe(0);

      rmSync(sessionDir, { recursive: true, force: true });
    });
  });
});
