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
    errorMessage: overrides?.errorMessage,
    timestamp: Date.now(),
  };
}

function systemBlock(message = "engine:started") {
  return { kind: "system" as const, message, timestamp: Date.now() };
}

function thinkingBlock(content = "reasoning about the problem") {
  return { kind: "thinking" as const, content, timestamp: Date.now() };
}

function userMessageBlock(
  content = "hello",
  overrides?: { pending?: boolean; injected?: boolean },
) {
  return {
    kind: "userMessage" as const,
    content,
    timestamp: Date.now(),
    ...overrides,
  };
}

function todoListBlock(
  todos = [
    { content: "First task", status: "completed" as const },
    { content: "Second task", status: "in_progress" as const },
    { content: "Third task", status: "pending" as const },
  ],
) {
  return { kind: "todoList" as const, todos, timestamp: Date.now() };
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

  it("validates a ToolEntry snapshot", () => {
    const block = toolBlock();
    const result = OutputSnapshotSchema.safeParse(block);
    expect(result.success).toBe(true);
  });

  it("validates an AgentBlock snapshot with completed status", () => {
    const block = agentBlock({ status: "completed" });
    const result = OutputSnapshotSchema.safeParse(block);
    expect(result.success).toBe(true);
  });

  it("validates a SystemBlock snapshot", () => {
    const block = systemBlock();
    const result = OutputSnapshotSchema.safeParse(block);
    expect(result.success).toBe(true);
  });

  it("validates a ThinkingBlock snapshot", () => {
    const block = thinkingBlock();
    const result = OutputSnapshotSchema.safeParse(block);
    expect(result.success).toBe(true);
  });

  it("validates a UserMessageBlock snapshot", () => {
    const block = userMessageBlock("hi", { pending: false, injected: true });
    const result = OutputSnapshotSchema.safeParse(block);
    expect(result.success).toBe(true);
  });

  it("validates a UserMessageBlock snapshot without optional fields", () => {
    const block = userMessageBlock("hi");
    const result = OutputSnapshotSchema.safeParse(block);
    expect(result.success).toBe(true);
  });

  it("validates a TodoListBlock snapshot", () => {
    const block = todoListBlock();
    const result = OutputSnapshotSchema.safeParse(block);
    expect(result.success).toBe(true);
  });

  it("validates a TodoListBlock snapshot with empty todos", () => {
    const block = todoListBlock([]);
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
        errorMessage: "something failed",
      }),
    ];
    const snapshots = toSnapshot(blocks);

    const agentSnap = snapshots[0] as any;
    expect(agentSnap.latestChild).toBe("read_file");
    expect(agentSnap.duration).toBe(5000);
    expect(agentSnap.errorMessage).toBe("something failed");
  });

  it("preserves all ToolEntry fields on serialize", () => {
    const block = {
      ...toolBlock("Edit", "src/main.ts"),
      filePath: "/abs/src/main.ts",
      diff: "--- a\n+++ b",
      content: "file content",
      filetype: "ts",
    };
    const snapshots = toSnapshot([block] as any);

    expect(snapshots).toHaveLength(1);
    const snap = snapshots[0] as any;
    expect(snap.name).toBe("Edit");
    expect(snap.filePath).toBe("/abs/src/main.ts");
    expect(snap.diff).toBe("--- a\n+++ b");
    expect(snap.content).toBe("file content");
    expect(snap.filetype).toBe("ts");
  });

  it("strips expanded from AgentBlock on serialize", () => {
    const block = { ...agentBlock({ status: "completed" }), expanded: true };
    const snapshots = toSnapshot([block] as any);

    expect(snapshots).toHaveLength(1);
    expect((snapshots[0] as any).expanded).toBeUndefined();
  });

  it("preserves all fields on nested ToolEntrys in AgentBlock children", () => {
    const children = [{ ...toolBlock("Edit", "a.ts"), filePath: "/a.ts", diff: "diff" }];
    const block = agentBlock({ status: "completed", children: children as any });
    const snapshots = toSnapshot([block] as any);

    const agentSnap = snapshots[0] as any;
    expect(agentSnap.children[0].name).toBe("Edit");
    expect(agentSnap.children[0].filePath).toBe("/a.ts");
    expect(agentSnap.children[0].diff).toBe("diff");
  });

  it("handles empty block array", () => {
    const snapshots = toSnapshot([]);
    expect(snapshots).toEqual([]);
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
      systemBlock("workflow:started"),
      thinkingBlock("let me think"),
      userMessageBlock("user said this", { pending: false, injected: false }),
      todoListBlock([
        { content: "done", status: "completed" },
        { content: "doing", status: "in_progress" },
      ]),
    ];

    const json = JSON.stringify(toSnapshot(original));
    const restored = fromSnapshot(JSON.parse(json));

    expect(restored).toHaveLength(7);
    expect(restored[0].kind).toBe("text");
    expect(restored[1].kind).toBe("tool");
    expect(restored[2].kind).toBe("agent");
    expect(restored[3].kind).toBe("system");
    expect(restored[4].kind).toBe("thinking");
    expect(restored[5].kind).toBe("userMessage");
    expect(restored[6].kind).toBe("todoList");
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

// ---------------------------------------------------------------------------
// Question block persistence
// ---------------------------------------------------------------------------

describe("question block persistence", () => {
  function questionBlock(overrides?: {
    toolUseId?: string;
    questions?: Array<{ question: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }>;
    answers?: Record<string, string>;
    cancelled?: boolean;
  }) {
    return {
      kind: "question" as const,
      toolUseId: overrides?.toolUseId ?? "tool_q1",
      questions: overrides?.questions ?? [
        { question: "Which framework?", options: [{ label: "React" }, { label: "Vue" }] },
      ],
      ...(overrides?.answers !== undefined && { answers: overrides.answers }),
      ...(overrides?.cancelled !== undefined && { cancelled: overrides.cancelled }),
      timestamp: 1000,
    };
  }

  it("persists answered question blocks", () => {
    const block = questionBlock({ answers: { "Which framework?": "React" } });
    const snapshots = toSnapshot([block]);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].kind).toBe("question");
    const restored = fromSnapshot(snapshots);
    expect(restored[0]).toEqual(block);
  });

  it("persists cancelled question blocks", () => {
    const block = questionBlock({ cancelled: true });
    const snapshots = toSnapshot([block]);
    const restored = fromSnapshot(snapshots);
    expect(restored[0]).toEqual(block);
  });

  it("normalizes pending questions to cancelled on serialize", () => {
    const pending = questionBlock(); // no answers, not cancelled
    const snapshots = toSnapshot([pending]);
    expect(snapshots).toHaveLength(1);
    expect((snapshots[0] as any).kind).toBe("question");
    expect((snapshots[0] as any).cancelled).toBe(true);
    expect((snapshots[0] as any).answers).toBeUndefined();
  });

  it("round-trips multi-question multi-select answers", () => {
    const block = questionBlock({
      questions: [
        { question: "Framework?", options: [{ label: "React" }, { label: "Vue" }] },
        { question: "Features?", options: [{ label: "Dark" }, { label: "Auto" }], multiSelect: true },
      ],
      answers: { "Framework?": "React", "Features?": "Dark, Auto" },
    });
    const restored = fromSnapshot(toSnapshot([block]));
    expect(restored).toHaveLength(1);
    expect(restored[0]).toEqual(block);
  });
});
