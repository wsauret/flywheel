import { describe, it, expect } from "bun:test";
import { isHandoffPath } from "../src/tui/utils/text";
import { formatDuration } from "../src/infra/format";
import type {
  AnyBlock,
  TextBlock,
  ToolEntry,
  AgentBlock,
  SystemBlock,
  UserMessageBlock,
} from "../src/infra/output-blocks";
import type { Theme } from "../src/tui/shared/context/theme";

/**
 * Output Blocks rendering logic tests.
 *
 * These test the pure-logic functions used by block rendering components.
 * Actual OpenTUI rendering cannot be tested in unit tests (per AGENTS.md) —
 * visual verification is done via tmux UAT.
 *
 * TextBlock renders via the native OpenTUI <markdown> element with
 * syntaxStyle (from theme context) and content (from block.content).
 * It uses streaming={true} and conceal={true} for live output.
 */

// ── TextBlock props interface ──

describe("TextBlock expected props", () => {
  /**
   * TextBlock renders an OpenTUI <markdown> element with:
   *   - syntaxStyle: SyntaxStyle from useTheme().syntax
   *   - content: block.content (string)
   *   - streaming: true
   *   - conceal: true
   *
   * We can't render OpenTUI components in unit tests, but we verify
   * the TextBlock data shape is correct for the component's contract.
   */
  it("TextBlock has the content field needed by <markdown>", () => {
    const block: TextBlock = { kind: "text", content: "# Hello World", timestamp: 1 };
    expect(block.content).toBe("# Hello World");
    expect(typeof block.content).toBe("string");
  });

  it("TextBlock content can be empty string (streaming start)", () => {
    const block: TextBlock = { kind: "text", content: "", timestamp: 1 };
    expect(block.content).toBe("");
  });

  it("TextBlock content can contain markdown with code fences", () => {
    const block: TextBlock = {
      kind: "text",
      content: "```ts\nconst x = 1;\n```",
      timestamp: 1,
    };
    expect(block.content).toContain("```ts");
  });
});

// ── Duration formatting ──

describe("formatDuration", () => {
  it("formats sub-second durations in milliseconds", () => {
    expect(formatDuration(50)).toBe("50ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("formats seconds with one decimal", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(12345)).toBe("12.3s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(60000)).toBe("1m 0s");
    expect(formatDuration(90000)).toBe("1m 30s");
    expect(formatDuration(125000)).toBe("2m 5s");
  });

  it("handles zero", () => {
    expect(formatDuration(0)).toBe("0ms");
  });
});

// ── Block kind selection logic ──

/**
 * Replicated from block-renderer.tsx: determine which component to render
 * based on block.kind. Returns the component name as a string.
 */
function selectBlockComponent(block: AnyBlock): string {
  switch (block.kind) {
    case "text":
      return "TextBlock";
    case "tool":
      return "ToolEntry";
    case "agent":
      return "AgentBlock";
    case "system":
      return "SystemBlock";
    default:
      return "Unknown";
  }
}

describe("selectBlockComponent", () => {
  it("selects TextBlock for text kind", () => {
    const block: TextBlock = { kind: "text", content: "hello", timestamp: 1 };
    expect(selectBlockComponent(block)).toBe("TextBlock");
  });

  it("selects ToolEntry for tool kind", () => {
    const block: ToolEntry = { kind: "tool", name: "Bash", detail: "ls", timestamp: 1 };
    expect(selectBlockComponent(block)).toBe("ToolEntry");
  });

  it("selects AgentBlock for agent kind", () => {
    const block: AgentBlock = {
      kind: "agent",
      id: "a1",
      agentLabel: "Explore",
      description: "Searching",
      status: "active",
      children: [],
      timestamp: 1,
    };
    expect(selectBlockComponent(block)).toBe("AgentBlock");
  });

  it("selects SystemBlock for system kind", () => {
    const block: SystemBlock = { kind: "system", message: "Starting...", timestamp: 1 };
    expect(selectBlockComponent(block)).toBe("SystemBlock");
  });
});

// ── AgentBlock display text logic ──

/**
 * Replicated from agent-block.tsx: derive display text for different agent states.
 */
function agentDisplayText(agent: AgentBlock): {
  icon: string;
  label: string;
  detail: string;
  subline?: string;
} {
  const label = `${agent.agentLabel}: ${agent.description}`;

  switch (agent.status) {
    case "active": {
      const subline = agent.latestChild ? `↳ ${agent.latestChild}` : undefined;
      return { icon: "◐", label, detail: "", subline };
    }
    case "completed": {
      const duration = agent.duration != null ? formatDuration(agent.duration) : "";
      const detail = duration ? ` (${duration})` : "";
      const toolInfo = agent.children.length > 0 ? `└ ${agent.children.length} tool calls` : undefined;
      return { icon: "✓", label, detail, subline: toolInfo };
    }
    case "error": {
      const subline = agent.errorMessage ? `  ${agent.errorMessage}` : undefined;
      return { icon: "✗", label, detail: "", subline };
    }
  }
}

describe("agentDisplayText", () => {
  it("active agent shows spinner icon and latest child", () => {
    const agent: AgentBlock = {
      kind: "agent",
      id: "a1",
      agentLabel: "Explore",
      description: "Searching codebase",
      status: "active",
      children: [],
      latestChild: "Reading src/index.ts",
      timestamp: 1,
    };
    const result = agentDisplayText(agent);
    expect(result.icon).toBe("◐");
    expect(result.label).toBe("Explore: Searching codebase");
    expect(result.subline).toBe("↳ Reading src/index.ts");
  });

  it("active agent without latestChild has no subline", () => {
    const agent: AgentBlock = {
      kind: "agent",
      id: "a1",
      agentLabel: "Explore",
      description: "Starting",
      status: "active",
      children: [],
      timestamp: 1,
    };
    const result = agentDisplayText(agent);
    expect(result.icon).toBe("◐");
    expect(result.subline).toBeUndefined();
  });

  it("completed agent shows checkmark, duration, and tool count", () => {
    const children: ToolEntry[] = Array.from({ length: 8 }, (_, i) => ({
      kind: "tool", name: `Tool${i}`, detail: "", timestamp: 1,
    }));
    const agent: AgentBlock = {
      kind: "agent",
      id: "a1",
      agentLabel: "Explore",
      description: "Searching codebase",
      status: "completed",
      children,
      duration: 12345,
      timestamp: 1,
    };
    const result = agentDisplayText(agent);
    expect(result.icon).toBe("✓");
    expect(result.label).toBe("Explore: Searching codebase");
    expect(result.detail).toBe(" (12.3s)");
    expect(result.subline).toBe("└ 8 tool calls");
  });

  it("completed agent without duration has no duration detail", () => {
    const children: ToolEntry[] = Array.from({ length: 3 }, (_, i) => ({
      kind: "tool", name: `Tool${i}`, detail: "", timestamp: 1,
    }));
    const agent: AgentBlock = {
      kind: "agent",
      id: "a1",
      agentLabel: "Explore",
      description: "Done",
      status: "completed",
      children,
      timestamp: 1,
    };
    const result = agentDisplayText(agent);
    expect(result.detail).toBe("");
    expect(result.subline).toBe("└ 3 tool calls");
  });

  it("error agent shows X icon and error message", () => {
    const agent: AgentBlock = {
      kind: "agent",
      id: "a1",
      agentLabel: "Explore",
      description: "Searching codebase",
      status: "error",
      children: [],
      errorMessage: "Timeout exceeded",
      timestamp: 1,
    };
    const result = agentDisplayText(agent);
    expect(result.icon).toBe("✗");
    expect(result.label).toBe("Explore: Searching codebase");
    expect(result.subline).toBe("  Timeout exceeded");
  });

  it("error agent without errorMessage has no subline", () => {
    const agent: AgentBlock = {
      kind: "agent",
      id: "a1",
      agentLabel: "Explore",
      description: "Failed",
      status: "error",
      children: [],
      timestamp: 1,
    };
    const result = agentDisplayText(agent);
    expect(result.icon).toBe("✗");
    expect(result.subline).toBeUndefined();
  });
});

// ── ToolEntry display text logic ──

describe("toolBlockDisplayText", () => {
  function toolDisplayText(tool: ToolEntry): string {
    return `▸ ${tool.name}: ${tool.detail}`;
  }

  it("formats tool name and detail", () => {
    const tool: ToolEntry = { kind: "tool", name: "Bash", detail: "ls -la", timestamp: 1 };
    expect(toolDisplayText(tool)).toBe("▸ Bash: ls -la");
  });

  it("handles empty detail", () => {
    const tool: ToolEntry = { kind: "tool", name: "Read", detail: "", timestamp: 1 };
    expect(toolDisplayText(tool)).toBe("▸ Read: ");
  });
});

// ── hasContent / blockCountText logic ──

describe("OutputWindow block-aware logic", () => {
  /**
   * Replicated from output-window.tsx: determines if there's content to show.
   * Now blocks-only — outputLines no longer used for rendering.
   */
  function hasContent(outputBlocks: unknown[]): boolean {
    return outputBlocks.length > 0;
  }

  /**
   * Replicated from output-window.tsx: block count display text.
   */
  function blockCountText(outputBlocks: unknown[]): string {
    return `${outputBlocks.length} blocks`;
  }

  it("hasContent is true with blocks", () => {
    expect(hasContent([{ kind: "text" }])).toBe(true);
  });

  it("hasContent is false with empty blocks", () => {
    expect(hasContent([])).toBe(false);
  });

  it("blockCountText shows block count", () => {
    expect(blockCountText([{ kind: "text" }, { kind: "tool" }, { kind: "agent" }]))
      .toBe("3 blocks");
  });

  it("blockCountText shows 0 for empty", () => {
    expect(blockCountText([])).toBe("0 blocks");
  });
});

// ── Color contract tests ──
//
// These verify the data contracts that each block component uses for color.
// We can't render OpenTUI components in unit tests, but we CAN verify that:
// 1. The Theme type has the required color keys each component references
// 2. The expected color key per block type is documented and stable
//
// This acts as a living specification: if a theme key is renamed or removed,
// these tests will fail at compile time (type errors) or runtime.

describe("Block color contracts", () => {
  /**
   * Simulate theme color lookup per block type.
   * Each function mirrors the `fg={}` prop in the corresponding component.
   */
  function textBlockColor(theme: Theme): Theme[keyof Theme] {
    // TextBlock uses <markdown> with syntaxStyle — no explicit fg.
    // The text color comes from theme.text via the markdown renderer.
    return theme.text;
  }

  function toolBlockColor(theme: Theme): Theme[keyof Theme] {
    // ToolEntry: fg={themeCtx.theme.textMuted} — subdued tool calls
    return theme.textMuted;
  }

  function systemBlockColor(theme: Theme): Theme[keyof Theme] {
    // SystemBlock: fg={themeCtx.theme.textMuted} — dim system messages
    return theme.textMuted;
  }

  function agentBlockActiveLabelColor(theme: Theme): Theme[keyof Theme] {
    // AgentBlock active header: fg={themeCtx.theme.primary} — blue pop
    return theme.primary;
  }

  function agentBlockCompletedLabelColor(theme: Theme): Theme[keyof Theme] {
    // AgentBlock completed header: fg={themeCtx.theme.text}
    return theme.text;
  }

  function agentBlockErrorLabelColor(theme: Theme): Theme[keyof Theme] {
    // AgentBlock error header: fg={themeCtx.theme.error}
    return theme.error;
  }

  // Use a mock theme to verify the contracts at runtime
  const mockTheme: Pick<
    Theme,
    "text" | "textMuted" | "primary" | "error"
  > = {
    text: "white" as any,
    textMuted: "gray" as any,
    primary: "blue" as any,
    error: "red" as any,
  };

  it("TextBlock uses theme.text (white — agent prose)", () => {
    expect(textBlockColor(mockTheme as Theme)).toBe(mockTheme.text);
  });

  it("ToolEntry uses theme.textMuted (gray — subdued tool calls)", () => {
    expect(toolBlockColor(mockTheme as Theme)).toBe(mockTheme.textMuted);
  });

  it("SystemBlock uses theme.textMuted (dim — system messages)", () => {
    expect(systemBlockColor(mockTheme as Theme)).toBe(mockTheme.textMuted);
  });

  it("AgentBlock active label uses theme.primary (blue — pops)", () => {
    expect(agentBlockActiveLabelColor(mockTheme as Theme)).toBe(mockTheme.primary);
  });

  it("AgentBlock completed label uses theme.text (white)", () => {
    expect(agentBlockCompletedLabelColor(mockTheme as Theme)).toBe(mockTheme.text);
  });

  it("AgentBlock error label uses theme.error (red)", () => {
    expect(agentBlockErrorLabelColor(mockTheme as Theme)).toBe(mockTheme.error);
  });

  // Verify the distinct visual hierarchy:
  // - Agent prose (text): theme.text (bright white)
  // - Active agent label: theme.primary (blue — most prominent)
  // - Tool calls, system, context: theme.textMuted (gray — subdued)
  it("color hierarchy: text, primary, and textMuted are distinct keys", () => {
    const keys = new Set(["text", "textMuted", "primary"]);
    expect(keys.size).toBe(3);
    // Verify these are all valid Theme keys
    const themeKeys: (keyof Theme)[] = ["text", "textMuted", "primary"];
    expect(themeKeys).toHaveLength(3);
  });
});

// ── Pending block splitting logic (output-window.tsx) ──

describe("OutputWindow pending block splitting", () => {
  /**
   * Replicated from output-window.tsx: split blocks into scrollable
   * (everything except pending user messages) and pinned (pending user messages).
   */
  function splitBlocks(blocks: AnyBlock[]): { scroll: AnyBlock[]; pinned: AnyBlock[] } {
    return {
      scroll: blocks.filter(b => !(b.kind === "userMessage" && (b as UserMessageBlock).pending)),
      pinned: blocks.filter(b => b.kind === "userMessage" && (b as UserMessageBlock).pending),
    };
  }

  it("separates pending user messages into pinned group", () => {
    const blocks: AnyBlock[] = [
      { kind: "text", content: "hello", timestamp: 1 },
      { kind: "userMessage", content: "queued msg", timestamp: 2, pending: true },
    ];
    const { scroll, pinned } = splitBlocks(blocks);
    expect(scroll).toHaveLength(1);
    expect(scroll[0].kind).toBe("text");
    expect(pinned).toHaveLength(1);
    expect(pinned[0].kind).toBe("userMessage");
  });

  it("keeps non-pending user messages in scroll group", () => {
    const blocks: AnyBlock[] = [
      { kind: "userMessage", content: "sent msg", timestamp: 1, pending: false },
      { kind: "userMessage", content: "queued msg", timestamp: 2, pending: true },
    ];
    const { scroll, pinned } = splitBlocks(blocks);
    expect(scroll).toHaveLength(1);
    expect((scroll[0] as UserMessageBlock).content).toBe("sent msg");
    expect(pinned).toHaveLength(1);
    expect((pinned[0] as UserMessageBlock).content).toBe("queued msg");
  });

  it("returns empty pinned when no pending messages", () => {
    const blocks: AnyBlock[] = [
      { kind: "text", content: "hello", timestamp: 1 },
      { kind: "userMessage", content: "sent msg", timestamp: 2 },
    ];
    const { scroll, pinned } = splitBlocks(blocks);
    expect(scroll).toHaveLength(2);
    expect(pinned).toHaveLength(0);
  });

  it("treats user messages without pending field as non-pending", () => {
    const blocks: AnyBlock[] = [
      { kind: "userMessage", content: "normal msg", timestamp: 1 },
    ];
    const { scroll, pinned } = splitBlocks(blocks);
    expect(scroll).toHaveLength(1);
    expect(pinned).toHaveLength(0);
  });

  it("handles empty blocks array", () => {
    const { scroll, pinned } = splitBlocks([]);
    expect(scroll).toHaveLength(0);
    expect(pinned).toHaveLength(0);
  });

  it("preserves order of non-pending blocks", () => {
    const blocks: AnyBlock[] = [
      { kind: "text", content: "first", timestamp: 1 },
      { kind: "userMessage", content: "queued", timestamp: 2, pending: true },
      { kind: "text", content: "second", timestamp: 3 },
      { kind: "system", message: "info", timestamp: 4 },
    ];
    const { scroll, pinned } = splitBlocks(blocks);
    expect(scroll).toHaveLength(3);
    expect((scroll[0] as TextBlock).content).toBe("first");
    expect((scroll[1] as TextBlock).content).toBe("second");
    expect(scroll[2].kind).toBe("system");
    expect(pinned).toHaveLength(1);
  });
});

// ── Handoff path detection ──

describe("isHandoffPath", () => {
  it("matches a standard handoff doc path", () => {
    expect(isHandoffPath("/project/.flywheel/sessions/abc-123/handoffs/work_step1.json")).toBe(true);
  });

  it("matches nested inside any session id", () => {
    expect(isHandoffPath("/x/.flywheel/sessions/f6648678-361d-4b22-a9b9-61622531cbf5/handoffs/work_abc.json")).toBe(true);
  });

  it("rejects a normal source file path", () => {
    expect(isHandoffPath("src/app.ts")).toBe(false);
  });

  it("rejects a .flywheel path that is not a handoff", () => {
    expect(isHandoffPath("/project/.flywheel/sessions/abc-123/context.md")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isHandoffPath(undefined)).toBe(false);
  });
});
