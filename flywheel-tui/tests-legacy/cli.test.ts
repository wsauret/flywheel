import { describe, it, expect } from "bun:test";
import { parseArgs } from "../src/orchestration/cli/args";

// ---------------------------------------------------------------------------
// CLI args tests (simplified — all args route to TUI)
// ---------------------------------------------------------------------------

describe("CLI args — parseArgs", () => {
  it("returns { command: 'tui' } for empty args", async () => {
    const result = await parseArgs([]);
    expect(result).toEqual({ command: "tui" });
  });

  it("returns { command: 'tui' } for any args", async () => {
    const result = await parseArgs(["work", "plan.md"]);
    expect(result).toEqual({ command: "tui" });
  });

  it("returns { command: 'tui' } for workflow subcommands", async () => {
    const result = await parseArgs(["plan", "description"]);
    expect(result).toEqual({ command: "tui" });
  });

  it("never returns null", async () => {
    const result1 = await parseArgs([]);
    expect(result1).not.toBeNull();

    const result2 = await parseArgs(["--unknown"]);
    expect(result2).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CLI main() tests
// ---------------------------------------------------------------------------

describe("CLI main()", () => {
  it("main() always dispatches to TUI", async () => {
    const parsed = await parseArgs([]);
    expect(parsed).toEqual({ command: "tui" });
  });
});
