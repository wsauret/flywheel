import { describe, it, expect } from "bun:test";

import {
  OutputSnapshotSchema,
  toSnapshot,
  fromSnapshot,
  type OutputSnapshot,
} from "../src/orchestration/session/output-schemas";

// ---------------------------------------------------------------------------
// Helpers — standalone block fixtures (NOT imported from TUI types)
// ---------------------------------------------------------------------------

function textBlock(content = "hello world") {
  return { kind: "text" as const, content, timestamp: Date.now() };
}

function toolBlock(name = "read_file", detail = "/src/main.ts") {
  return { kind: "tool" as const, name, detail, timestamp: Date.now() };
}

function agentBlock(
  overrides?: Partial<{
    id: string;
    agentLabel: string;
    description: string;
    status: "active" | "completed" | "error";
    children: ReturnType<typeof toolBlock>[];
    latestChild: string;
    duration: number;
    toolCount: number;
    errorMessage: string;
  }>,
) {
  return {
    kind: "agent" as const,
    id: overrides?.id ?? "agent-1",
    agentLabel: overrides?.agentLabel ?? "Researcher",
    description: overrides?.description ?? "Investigating codebase",
    status: overrides?.status ?? "active",
    children: overrides?.children ?? [toolBlock()],
    latestChild: overrides?.latestChild,
    duration: overrides?.duration,
    toolCount: overrides?.toolCount,
    errorMessage: overrides?.errorMessage,
    timestamp: Date.now(),
  };
}

function contextGroupBlock(tools?: ReturnType<typeof toolBlock>[]) {
  return {
    kind: "contextGroup" as const,
    tools: tools ?? [toolBlock("glob", "**/*.ts"), toolBlock("grep", "import")],
    timestamp: Date.now(),
  };
}

function systemBlock(message = "subprocess:spawned") {
  return { kind: "system" as const, message, timestamp: Date.now() };
}

// ---------------------------------------------------------------------------
// Zod schema validation
// ---------------------------------------------------------------------------

describe("OutputSnapshotSchema — validation", () => {
  it("validates a TextBlock snapshot", () => {
    const block = textBlock();
    const result = OutputSnapshotSchema.safeParse(block);
    expect(result.success).toBe(true);
  });

  it("validates a ToolBlock snapshot", () => {
    const block = toolBlock();
    const result = OutputSnapshotSchema.safeParse(block);
    expect(result.success).toBe(true);
  });

  it("validates an AgentBlock snapshot with completed status", () => {
    const block = agentBlock({ status: "completed" });
    const result = OutputSnapshotSchema.safeParse(block);
    expect(result.success).toBe(true);
  });

  it("validates a ContextGroupBlock snapshot", () => {
    const block = contextGroupBlock();
    const result = OutputSnapshotSchema.safeParse(block);
    expect(result.success).toBe(true);
  });

  it("validates a SystemBlock snapshot", () => {
    const block = systemBlock();
    const result = OutputSnapshotSchema.safeParse(block);
    expect(result.success).toBe(true);
  });

  it("rejects unknown kind", () => {
    const block = { kind: "unknown", content: "x", timestamp: Date.now() };
    const result = OutputSnapshotSchema.safeParse(block);
    expect(result.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    const result = OutputSnapshotSchema.safeParse({ kind: "text" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toSnapshot — serialization
// ---------------------------------------------------------------------------

describe("toSnapshot — serialization", () => {
  it("converts a mixed array of blocks to snapshots", () => {
    const blocks = [textBlock(), toolBlock(), systemBlock()];
    const snapshots = toSnapshot(blocks);

    expect(snapshots).toHaveLength(3);
    expect(snapshots[0].kind).toBe("text");
    expect(snapshots[1].kind).toBe("tool");
    expect(snapshots[2].kind).toBe("system");
  });

  it("normalizes active AgentBlock status to paused", () => {
    const blocks = [agentBlock({ status: "active" })];
    const snapshots = toSnapshot(blocks);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].kind).toBe("agent");
    // Active agents should be normalized to "paused" on serialize
    expect((snapshots[0] as any).status).toBe("paused");
  });

  it("preserves completed AgentBlock status", () => {
    const blocks = [agentBlock({ status: "completed" })];
    const snapshots = toSnapshot(blocks);

    expect((snapshots[0] as any).status).toBe("completed");
  });

  it("preserves error AgentBlock status", () => {
    const blocks = [agentBlock({ status: "error" })];
    const snapshots = toSnapshot(blocks);

    expect((snapshots[0] as any).status).toBe("error");
  });

  it("preserves AgentBlock children array", () => {
    const children = [toolBlock("read", "a.ts"), toolBlock("write", "b.ts")];
    const blocks = [agentBlock({ children })];
    const snapshots = toSnapshot(blocks);

    const agentSnap = snapshots[0] as any;
    expect(agentSnap.children).toHaveLength(2);
    expect(agentSnap.children[0].name).toBe("read");
    expect(agentSnap.children[1].name).toBe("write");
  });

  it("preserves AgentBlock optional fields", () => {
    const blocks = [
      agentBlock({
        latestChild: "read_file",
        duration: 5000,
        toolCount: 3,
        errorMessage: "something failed",
      }),
    ];
    const snapshots = toSnapshot(blocks);

    const agentSnap = snapshots[0] as any;
    expect(agentSnap.latestChild).toBe("read_file");
    expect(agentSnap.duration).toBe(5000);
    expect(agentSnap.toolCount).toBe(3);
    expect(agentSnap.errorMessage).toBe("something failed");
  });

  it("handles empty block array", () => {
    const snapshots = toSnapshot([]);
    expect(snapshots).toEqual([]);
  });

  it("preserves ContextGroupBlock tools", () => {
    const tools = [toolBlock("glob", "**/*.ts")];
    const blocks = [contextGroupBlock(tools)];
    const snapshots = toSnapshot(blocks);

    const groupSnap = snapshots[0] as any;
    expect(groupSnap.tools).toHaveLength(1);
    expect(groupSnap.tools[0].name).toBe("glob");
  });
});

// ---------------------------------------------------------------------------
// fromSnapshot — deserialization
// ---------------------------------------------------------------------------

describe("fromSnapshot — deserialization", () => {
  it("converts snapshots back to block shapes", () => {
    const snapshots: OutputSnapshot[] = [
      { kind: "text", content: "hello", timestamp: 100 },
      { kind: "tool", name: "read", detail: "a.ts", timestamp: 200 },
      { kind: "system", message: "started", timestamp: 300 },
    ];
    const blocks = fromSnapshot(snapshots);

    expect(blocks).toHaveLength(3);
    expect(blocks[0].kind).toBe("text");
    expect(blocks[1].kind).toBe("tool");
    expect(blocks[2].kind).toBe("system");
  });

  it("preserves all fields through deserialization", () => {
    const snapshots: OutputSnapshot[] = [
      {
        kind: "agent",
        id: "a1",
        agentLabel: "Coder",
        description: "Writing code",
        status: "completed",
        children: [{ kind: "tool", name: "write", detail: "out.ts", timestamp: 50 }],
        duration: 3000,
        toolCount: 1,
        timestamp: 100,
      },
    ];
    const blocks = fromSnapshot(snapshots);

    expect(blocks).toHaveLength(1);
    const agent = blocks[0] as any;
    expect(agent.kind).toBe("agent");
    expect(agent.id).toBe("a1");
    expect(agent.agentLabel).toBe("Coder");
    expect(agent.status).toBe("completed");
    expect(agent.children).toHaveLength(1);
    expect(agent.duration).toBe(3000);
  });

  it("handles empty snapshot array", () => {
    const blocks = fromSnapshot([]);
    expect(blocks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: blocks -> snapshots -> JSON -> snapshots -> blocks
// ---------------------------------------------------------------------------

describe("round-trip serialization", () => {
  it("round-trips TextBlock through JSON", () => {
    const original = [textBlock("some output")];
    const json = JSON.stringify(toSnapshot(original));
    const restored = fromSnapshot(JSON.parse(json));

    expect(restored).toHaveLength(1);
    expect(restored[0].kind).toBe("text");
    expect((restored[0] as any).content).toBe("some output");
  });

  it("round-trips all block types through JSON", () => {
    const original = [
      textBlock("output"),
      toolBlock("read_file", "/src/main.ts"),
      agentBlock({
        status: "completed",
        children: [toolBlock("glob", "*.ts")],
        duration: 1234,
      }),
      contextGroupBlock([toolBlock("grep", "pattern")]),
      systemBlock("workflow:started"),
    ];

    const json = JSON.stringify(toSnapshot(original));
    const restored = fromSnapshot(JSON.parse(json));

    expect(restored).toHaveLength(5);
    expect(restored[0].kind).toBe("text");
    expect(restored[1].kind).toBe("tool");
    expect(restored[2].kind).toBe("agent");
    expect(restored[3].kind).toBe("contextGroup");
    expect(restored[4].kind).toBe("system");
  });

  it("active AgentBlock becomes paused after round-trip", () => {
    const original = [agentBlock({ status: "active" })];
    const json = JSON.stringify(toSnapshot(original));
    const restored = fromSnapshot(JSON.parse(json));

    expect((restored[0] as any).status).toBe("paused");
  });

  it("corrupt JSON returns empty array from fromSnapshot with Zod parse", () => {
    // fromSnapshot itself takes already-parsed data, but we test
    // that the schema rejects garbage and the caller can handle it
    const corrupt = "[{\"kind\":\"bogus\"}]";
    const parsed = JSON.parse(corrupt);

    // Each item should fail validation; fromSnapshot should filter/return empty
    const blocks = fromSnapshot(parsed);
    expect(blocks).toEqual([]);
  });

  it("partially corrupt array filters out bad items", () => {
    const mixed = [
      { kind: "text", content: "valid", timestamp: 100 },
      { kind: "garbage", foo: "bar" }, // invalid
      { kind: "system", message: "also valid", timestamp: 200 },
    ];

    const blocks = fromSnapshot(mixed as any);
    // Should keep valid blocks, skip invalid
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe("text");
    expect(blocks[1].kind).toBe("system");
  });
});
