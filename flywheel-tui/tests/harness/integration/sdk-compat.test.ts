/**
 * SDK Validation Gate — Phase 0
 *
 * Confirms that @anthropic-ai/sdk and @ast-grep/napi load and work correctly
 * under Bun. No actual API calls are made — this validates SDK loading, type
 * compatibility, and ast-grep parse/query functionality.
 *
 * This file serves as a permanent regression gate.
 */

import { describe, it, expect } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageCreateParamsStreaming,
  MessageCreateParamsNonStreaming,
  CacheControlEphemeral,
  TextBlockParam,
  ThinkingConfigEnabled,
  ThinkingConfigParam,
  RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { parse, Lang } from "@ast-grep/napi";
import type { SgRoot, SgNode } from "@ast-grep/napi";

// ---------------------------------------------------------------------------
// Anthropic SDK: loading and instantiation
// ---------------------------------------------------------------------------

describe("Anthropic SDK compatibility under Bun", () => {
  it("imports and instantiates the Anthropic client", () => {
    // Use a dummy key — no actual API calls are made
    const client = new Anthropic({ apiKey: "sk-ant-test-dummy-key" });

    expect(client).toBeDefined();
    expect(client.messages).toBeDefined();
  });

  it("exposes streaming message params type", () => {
    const params: MessageCreateParamsStreaming = {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    };

    expect(params.stream).toBe(true);
    expect(params.model).toBe("claude-sonnet-4-6");
  });

  it("exposes non-streaming message params type", () => {
    const params: MessageCreateParamsNonStreaming = {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    };

    expect(params.stream).toBe(false);
  });

  it("RawMessageStreamEvent type is importable and usable", () => {
    // Verify the union type exists and can be narrowed
    const event: RawMessageStreamEvent = {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-sonnet-4-6",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    };

    expect(event.type).toBe("message_start");
  });
});

// ---------------------------------------------------------------------------
// Anthropic SDK: prompt caching types
// ---------------------------------------------------------------------------

describe("Anthropic SDK: prompt caching type compatibility", () => {
  it("accepts cache_control on text content blocks", () => {
    const cacheControl: CacheControlEphemeral = { type: "ephemeral" };

    const block: TextBlockParam = {
      type: "text",
      text: "System prompt content for caching",
      cache_control: cacheControl,
    };

    expect(block.cache_control).toEqual({ type: "ephemeral" });
  });

  it("cache_control can be set on system message content blocks in params", () => {
    const params: MessageCreateParamsNonStreaming = {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      stream: false,
      system: [
        {
          type: "text",
          text: "You are a helpful assistant.",
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    };

    expect(params.system).toBeDefined();
    expect(Array.isArray(params.system)).toBe(true);
    const systemBlocks = params.system as TextBlockParam[];
    expect(systemBlocks[0]?.cache_control?.type).toBe("ephemeral");
  });
});

// ---------------------------------------------------------------------------
// Anthropic SDK: extended thinking types
// ---------------------------------------------------------------------------

describe("Anthropic SDK: extended thinking type compatibility", () => {
  it("ThinkingConfigEnabled accepts type and budget_tokens", () => {
    const config: ThinkingConfigEnabled = {
      type: "enabled",
      budget_tokens: 10000,
    };

    expect(config.type).toBe("enabled");
    expect(config.budget_tokens).toBe(10000);
  });

  it("ThinkingConfigParam union works in message params", () => {
    const thinking: ThinkingConfigParam = {
      type: "enabled",
      budget_tokens: 5000,
    };

    const params: MessageCreateParamsNonStreaming = {
      model: "claude-sonnet-4-6",
      max_tokens: 16000,
      stream: false,
      thinking,
      messages: [{ role: "user", content: "hello" }],
    };

    expect(params.thinking).toBeDefined();
    expect((params.thinking as ThinkingConfigEnabled).budget_tokens).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// ast-grep: parse and query under Bun
// ---------------------------------------------------------------------------

describe("ast-grep compatibility under Bun", () => {
  const tsSnippet = `
    function greet(name: string): string {
      return \`Hello, \${name}!\`;
    }
    const x: number = 42;
  `;

  it("parse() returns an SgRoot for TypeScript source", () => {
    const root: SgRoot = parse(Lang.TypeScript, tsSnippet);

    expect(root).toBeDefined();
    expect(root.root).toBeDefined();
  });

  it("root().findAll() returns matching nodes for a pattern", () => {
    const root = parse(Lang.TypeScript, tsSnippet);
    const nodes: SgNode[] = root.root().findAll("function $NAME($$$ARGS): $RET { $$$ }");

    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes[0]?.text()).toContain("greet");
  });

  it("root().find() locates a single node", () => {
    const root = parse(Lang.TypeScript, tsSnippet);
    const node = root.root().find("const $X: number = $VAL");

    expect(node).toBeDefined();
    expect(node?.text()).toContain("42");
  });

  it("SgNode provides range information", () => {
    const root = parse(Lang.TypeScript, tsSnippet);
    const node = root.root().find("const $X: number = $VAL");

    expect(node).toBeDefined();
    const range = node!.range();
    expect(range.start).toBeDefined();
    expect(range.end).toBeDefined();
    expect(range.start.line).toBeGreaterThanOrEqual(0);
  });

  it("handles empty findAll results gracefully", () => {
    const root = parse(Lang.TypeScript, tsSnippet);
    const nodes = root.root().findAll("class $NAME { $$$ }");

    expect(nodes).toEqual([]);
  });
});
