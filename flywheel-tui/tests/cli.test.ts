import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { parseArgs } from "../src/cli/args";

// ---------------------------------------------------------------------------
// CLI args tests
// ---------------------------------------------------------------------------

describe("CLI args — parseArgs", () => {
  // ── TUI mode (no args) ──

  it("returns { command: 'tui' } for empty args", async () => {
    const result = await parseArgs([]);
    expect(result).toEqual({ command: "tui" });
  });

  it("returns { command: 'tui' } when no flags are provided", async () => {
    const result = await parseArgs([]);
    expect(result).not.toBeNull();
    expect(result!.command).toBe("tui");
  });

  // ── work subcommand ──

  it("parses 'work <plan-path>'", async () => {
    const result = await parseArgs(["work", "plan.md"]);

    expect(result).not.toBeNull();
    expect(result!.command).toBe("work");
    if (result!.command === "work") {
      expect(result!.planPath).toBe("plan.md");
      expect(result!.config).toBeUndefined();
    }
  });

  it("'work' without plan path returns null", async () => {
    const result = await parseArgs(["work"]);
    expect(result).toBeNull();
  });

  it("parses 'work' with --config", async () => {
    const result = await parseArgs([
      "work",
      "plan.md",
      "--config",
      "flywheel.toml",
    ]);

    expect(result).not.toBeNull();
    expect(result!.command).toBe("work");
    if (result!.command === "work") {
      expect(result!.planPath).toBe("plan.md");
      expect(result!.config).toBe("flywheel.toml");
    }
  });

  it("parses 'work' with -c (short config alias)", async () => {
    const result = await parseArgs([
      "work",
      "plan.md",
      "-c",
      "flywheel.toml",
    ]);

    expect(result).not.toBeNull();
    if (result!.command === "work") {
      expect(result!.config).toBe("flywheel.toml");
    }
  });

  it("handles plan path with spaces", async () => {
    const result = await parseArgs(["work", "path/to/my plan.md"]);

    expect(result).not.toBeNull();
    if (result!.command === "work") {
      expect(result!.planPath).toBe("path/to/my plan.md");
    }
  });

  it("handles plan path with leading ./", async () => {
    const result = await parseArgs(["work", "./docs/plan.md"]);

    expect(result).not.toBeNull();
    if (result!.command === "work") {
      expect(result!.planPath).toBe("./docs/plan.md");
    }
  });

  // ── workflow subcommands ──

  it("parses 'plan <description>'", async () => {
    const result = await parseArgs(["plan", "add dark mode"]);
    expect(result).not.toBeNull();
    expect(result!.command).toBe("plan");
    if (result!.command === "plan") {
      expect(result!.description).toBe("add dark mode");
    }
  });

  it("parses 'review'", async () => {
    const result = await parseArgs(["review"]);
    expect(result).toEqual({ command: "review" });
  });

  it("parses 'ship'", async () => {
    const result = await parseArgs(["ship"]);
    expect(result).toEqual({ command: "ship" });
  });

  it("parses 'debug <description>'", async () => {
    const result = await parseArgs(["debug", "test failing"]);
    expect(result).not.toBeNull();
    expect(result!.command).toBe("debug");
    if (result!.command === "debug") {
      expect(result!.description).toBe("test failing");
    }
  });

  it("parses 'research <topic>'", async () => {
    const result = await parseArgs(["research", "event bus"]);
    expect(result).not.toBeNull();
    expect(result!.command).toBe("research");
    if (result!.command === "research") {
      expect(result!.topic).toBe("event bus");
    }
  });

  // ── Edge cases ──

  it("returns null for unknown flags", async () => {
    const result = await parseArgs(["--unknown-flag"]);
    expect(result).toBeNull();
  });

  it("bare positional without subcommand returns null (strict mode)", async () => {
    const result = await parseArgs(["plan.md"]);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CLI main() tests
// ---------------------------------------------------------------------------

describe("CLI main()", () => {
  it("main() with no args dispatches to TUI", async () => {
    const parsed = await parseArgs([]);
    expect(parsed).toEqual({ command: "tui" });
  });

  it("main() with 'work plan.md' dispatches to work", async () => {
    const parsed = await parseArgs(["work", "plan.md"]);
    expect(parsed).not.toBeNull();
    expect(parsed!.command).toBe("work");
  });

  it("main() with 'work' but no plan path shows error", async () => {
    const parsed = await parseArgs(["work"]);
    expect(parsed).toBeNull();
  });
});
