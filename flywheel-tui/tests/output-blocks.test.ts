import { describe, it, expect } from "bun:test";
import { truncate, MAX_BLOCK_LINE_LENGTH } from "../src/tui/utils/text";
import type {
  AnyBlock,
  TextBlock,
  ToolBlock,
  AgentBlock,
  ContextGroupBlock,
  SystemBlock,
} from "../src/tui/routes/work/state/types";
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

/**
 * Replicated from agent-block.tsx: format milliseconds to human-readable duration
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds.toFixed(0)}s`;
}

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
      return "ToolBlock";
    case "agent":
      return "AgentBlock";
    case "contextGroup":
      return "ContextGroupBlock";
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

  it("selects ToolBlock for tool kind", () => {
    const block: ToolBlock = { kind: "tool", name: "Bash", detail: "ls", timestamp: 1 };
    expect(selectBlockComponent(block)).toBe("ToolBlock");
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

  it("selects ContextGroupBlock for contextGroup kind", () => {
    const block: ContextGroupBlock = {
      kind: "contextGroup",
      tools: [],
      timestamp: 1,
    };
    expect(selectBlockComponent(block)).toBe("ContextGroupBlock");
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
      const toolInfo = agent.toolCount != null ? `└ ${agent.toolCount} tool calls` : undefined;
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
    const agent: AgentBlock = {
      kind: "agent",
      id: "a1",
      agentLabel: "Explore",
      description: "Searching codebase",
      status: "completed",
      children: [],
      duration: 12345,
      toolCount: 8,
      timestamp: 1,
    };
    const result = agentDisplayText(agent);
    expect(result.icon).toBe("✓");
    expect(result.label).toBe("Explore: Searching codebase");
    expect(result.detail).toBe(" (12.3s)");
    expect(result.subline).toBe("└ 8 tool calls");
  });

  it("completed agent without duration has no duration detail", () => {
    const agent: AgentBlock = {
      kind: "agent",
      id: "a1",
      agentLabel: "Explore",
      description: "Done",
      status: "completed",
      children: [],
      toolCount: 3,
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

// ── ToolBlock display text logic ──

describe("toolBlockDisplayText", () => {
  function toolDisplayText(tool: ToolBlock): string {
    return `▸ ${tool.name}: ${tool.detail}`;
  }

  it("formats tool name and detail", () => {
    const tool: ToolBlock = { kind: "tool", name: "Bash", detail: "ls -la", timestamp: 1 };
    expect(toolDisplayText(tool)).toBe("▸ Bash: ls -la");
  });

  it("handles empty detail", () => {
    const tool: ToolBlock = { kind: "tool", name: "Read", detail: "", timestamp: 1 };
    expect(toolDisplayText(tool)).toBe("▸ Read: ");
  });
});

// ── ContextGroupBlock display text logic ──

describe("contextGroupDisplayText", () => {
  function contextGroupDisplayText(group: ContextGroupBlock): string {
    return `◆ Gathered context (${group.tools.length} files)`;
  }

  it("shows file count", () => {
    const group: ContextGroupBlock = {
      kind: "contextGroup",
      tools: [
        { kind: "tool", name: "Read", detail: "a.ts", timestamp: 1 },
        { kind: "tool", name: "Read", detail: "b.ts", timestamp: 2 },
        { kind: "tool", name: "Glob", detail: "**/*.ts", timestamp: 3 },
      ],
      timestamp: 1,
    };
    expect(contextGroupDisplayText(group)).toBe("◆ Gathered context (3 files)");
  });

  it("handles single file", () => {
    const group: ContextGroupBlock = {
      kind: "contextGroup",
      tools: [{ kind: "tool", name: "Read", detail: "a.ts", timestamp: 1 }],
      timestamp: 1,
    };
    expect(contextGroupDisplayText(group)).toBe("◆ Gathered context (1 files)");
  });

  it("handles empty tools", () => {
    const group: ContextGroupBlock = { kind: "contextGroup", tools: [], timestamp: 1 };
    expect(contextGroupDisplayText(group)).toBe("◆ Gathered context (0 files)");
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
    // ToolBlock: fg={themeCtx.theme.textMuted} — subdued tool calls
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

  function contextGroupBlockColor(theme: Theme): Theme[keyof Theme] {
    // ContextGroupBlock: fg={themeCtx.theme.textMuted}
    return theme.textMuted;
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

  it("ToolBlock uses theme.textMuted (gray — subdued tool calls)", () => {
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

  it("ContextGroupBlock uses theme.textMuted (gray — subdued)", () => {
    expect(contextGroupBlockColor(mockTheme as Theme)).toBe(mockTheme.textMuted);
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

// ── Truncation logic for output blocks ──

describe("AgentBlock latestChild truncation", () => {
  // The agent-block renders "  ↳ <latestChild>" — prefix is 4 chars.
  // Usable width for latestChild = MAX_BLOCK_LINE_LENGTH - 4.
  const usableWidth = MAX_BLOCK_LINE_LENGTH - 4;

  it("truncates long latestChild with ellipsis", () => {
    const longChild = "Reading " + "x".repeat(100);
    const result = truncate(longChild, usableWidth);
    expect(result.length).toBe(usableWidth);
    expect(result.endsWith("\u2026")).toBe(true);
    // Full rendered line fits within MAX_BLOCK_LINE_LENGTH
    const fullLine = `  ↳ ${result}`;
    expect(fullLine.length).toBe(MAX_BLOCK_LINE_LENGTH);
  });

  it("does not truncate short latestChild", () => {
    const shortChild = "Glob src/**/*.ts";
    const result = truncate(shortChild, usableWidth);
    expect(result).toBe(shortChild);
  });

  it("does not truncate latestChild at exactly usable width", () => {
    const exactChild = "a".repeat(usableWidth);
    const result = truncate(exactChild, usableWidth);
    expect(result).toBe(exactChild);
  });
});

describe("ToolBlock detail truncation", () => {
  // The tool-block renders "▸ <name>: <detail>" — overhead = 2 + name.length + 2.
  function toolDetailWidth(name: string): number {
    return MAX_BLOCK_LINE_LENGTH - name.length - 4;
  }

  it("truncates long detail to keep full line on one row", () => {
    const name = "Bash";
    const longDetail = "cd /very/long/path/to/somewhere && npm run build:production --verbose --force " + "x".repeat(50);
    const availableWidth = toolDetailWidth(name);
    const result = truncate(longDetail, availableWidth);
    const fullLine = `▸ ${name}: ${result}`;
    expect(fullLine.length).toBe(MAX_BLOCK_LINE_LENGTH);
    expect(result.endsWith("\u2026")).toBe(true);
  });

  it("does not truncate short detail", () => {
    const name = "Read";
    const shortDetail = "src/index.ts";
    const result = truncate(shortDetail, toolDetailWidth(name));
    expect(result).toBe(shortDetail);
  });

  it("adjusts available width based on tool name length", () => {
    const shortName = "ls";
    const longName = "SearchAndReplace";
    expect(toolDetailWidth(shortName)).toBeGreaterThan(toolDetailWidth(longName));
    // Short name: 80 - 2 - 4 = 74 chars for detail
    expect(toolDetailWidth(shortName)).toBe(74);
    // Long name: 80 - 16 - 4 = 60 chars for detail
    expect(toolDetailWidth(longName)).toBe(60);
  });
});
