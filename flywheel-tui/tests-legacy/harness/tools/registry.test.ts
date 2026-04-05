/**
 * Tool registry — registration, lookup, LLM definition export,
 * and concurrency-aware batch execution.
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { createToolRegistry } from "../../../src/harness/tools/registry.js";
import type { HarnessTool, ToolContext, ToolResult } from "../../../src/harness/tools/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultContext: ToolContext = {
  cwd: "/tmp",
  env: {},
};

function createDummyTool(
  name: string,
  concurrency: "shared" | "exclusive" = "shared",
  executeFn?: (input: unknown, ctx: ToolContext) => Promise<ToolResult>,
): HarnessTool {
  return {
    name,
    description: `${name} tool`,
    inputSchema: z.object({ value: z.string() }),
    concurrency,
    execute: executeFn ?? (async () => ({ content: `${name} result` })),
  };
}

// ---------------------------------------------------------------------------
// Registration and lookup
// ---------------------------------------------------------------------------

describe("ToolRegistry registration", () => {
  it("registers and retrieves a tool by name", () => {
    const registry = createToolRegistry();
    const tool = createDummyTool("echo");
    registry.register(tool);
    expect(registry.get("echo")).toBe(tool);
  });

  it("returns undefined for unknown tool names", () => {
    const registry = createToolRegistry();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("getAll returns all registered tools", () => {
    const registry = createToolRegistry();
    registry.register(createDummyTool("a"));
    registry.register(createDummyTool("b"));
    registry.register(createDummyTool("c"));
    const all = registry.getAll();
    expect(all).toHaveLength(3);
    expect(all.map((t) => t.name).sort()).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// toLLMDefinitions
// ---------------------------------------------------------------------------

describe("toLLMDefinitions", () => {
  it("produces correct LLM-compatible definitions", () => {
    const registry = createToolRegistry();
    const schema = z.object({
      command: z.string().describe("The command to run"),
      timeout: z.number().optional().describe("Timeout in seconds"),
    });
    registry.register({
      name: "bash",
      description: "Execute a shell command",
      inputSchema: schema,
      concurrency: "exclusive",
      execute: async () => ({ content: "ok" }),
    });

    const defs = registry.toLLMDefinitions();
    expect(defs).toHaveLength(1);
    const def = defs[0]!;
    expect(def.name).toBe("bash");
    expect(def.description).toBe("Execute a shell command");
    expect(def.input_schema).toBeDefined();
    expect((def.input_schema as Record<string, unknown>).type).toBe("object");

    const props = (def.input_schema as Record<string, unknown>).properties as Record<string, unknown>;
    expect(props.command).toBeDefined();
    expect(props.timeout).toBeDefined();

    // Required should contain only non-optional fields
    const required = (def.input_schema as Record<string, unknown>).required as string[];
    expect(required).toContain("command");
    expect(required).not.toContain("timeout");
  });
});

// ---------------------------------------------------------------------------
// executeBatch — concurrency scheduling
// ---------------------------------------------------------------------------

describe("executeBatch concurrency", () => {
  it("executes shared tools in parallel", async () => {
    const registry = createToolRegistry();
    const order: string[] = [];

    registry.register(
      createDummyTool("a", "shared", async () => {
        order.push("a-start");
        await Bun.sleep(50);
        order.push("a-end");
        return { content: "a" };
      }),
    );
    registry.register(
      createDummyTool("b", "shared", async () => {
        order.push("b-start");
        await Bun.sleep(50);
        order.push("b-end");
        return { content: "b" };
      }),
    );

    const results = await registry.executeBatch(
      [
        { id: "1", name: "a", input: { value: "x" } },
        { id: "2", name: "b", input: { value: "y" } },
      ],
      defaultContext,
    );

    expect(results).toHaveLength(2);
    expect(results[0]!.content).toBe("a");
    expect(results[1]!.content).toBe("b");

    // Both should start before either finishes (parallel execution)
    expect(order.indexOf("a-start")).toBeLessThan(order.indexOf("a-end"));
    expect(order.indexOf("b-start")).toBeLessThan(order.indexOf("b-end"));
    // At least one of them starts before the other ends
    const aEndIdx = order.indexOf("a-end");
    const bStartIdx = order.indexOf("b-start");
    const bEndIdx = order.indexOf("b-end");
    const aStartIdx = order.indexOf("a-start");
    const bothParallel =
      (bStartIdx < aEndIdx) || (aStartIdx < bEndIdx);
    expect(bothParallel).toBe(true);
  });

  it("executes exclusive tools sequentially after prior tasks", async () => {
    const registry = createToolRegistry();
    const order: string[] = [];

    registry.register(
      createDummyTool("shared1", "shared", async () => {
        order.push("shared1-start");
        await Bun.sleep(30);
        order.push("shared1-end");
        return { content: "shared1" };
      }),
    );
    registry.register(
      createDummyTool("exclusive1", "exclusive", async () => {
        order.push("exclusive1-start");
        await Bun.sleep(10);
        order.push("exclusive1-end");
        return { content: "exclusive1" };
      }),
    );
    registry.register(
      createDummyTool("shared2", "shared", async () => {
        order.push("shared2-start");
        await Bun.sleep(10);
        order.push("shared2-end");
        return { content: "shared2" };
      }),
    );

    const results = await registry.executeBatch(
      [
        { id: "1", name: "shared1", input: { value: "x" } },
        { id: "2", name: "exclusive1", input: { value: "y" } },
        { id: "3", name: "shared2", input: { value: "z" } },
      ],
      defaultContext,
    );

    expect(results).toHaveLength(3);
    expect(results[0]!.content).toBe("shared1");
    expect(results[1]!.content).toBe("exclusive1");
    expect(results[2]!.content).toBe("shared2");

    // Exclusive must start after shared1 completes
    expect(order.indexOf("exclusive1-start")).toBeGreaterThan(
      order.indexOf("shared1-end"),
    );
    // shared2 starts after exclusive completes
    expect(order.indexOf("shared2-start")).toBeGreaterThan(
      order.indexOf("exclusive1-end"),
    );
  });

  it("returns error result for unknown tools", async () => {
    const registry = createToolRegistry();
    const results = await registry.executeBatch(
      [{ id: "1", name: "unknown", input: {} }],
      defaultContext,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(true);
    expect(results[0]!.content).toContain("Unknown tool");
  });

  it("catches tool execution errors and returns error result", async () => {
    const registry = createToolRegistry();
    registry.register(
      createDummyTool("fail", "shared", async () => {
        throw new Error("intentional failure");
      }),
    );

    const results = await registry.executeBatch(
      [{ id: "1", name: "fail", input: { value: "x" } }],
      defaultContext,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(true);
    expect(results[0]!.content).toContain("intentional failure");
  });
});
