import { describe, it, expect } from "bun:test";
import { parseArgs } from "../src/cli/args";

// ---------------------------------------------------------------------------
// CLI args tests — extended coverage
// ---------------------------------------------------------------------------

describe("CLI args — parseArgs", () => {
  it("parses 'work <plan-path>' command", async () => {
    const result = await parseArgs(["work", "my-plan.md"]);

    expect(result).not.toBeNull();
    expect(result!.command).toBe("work");
    expect(result!.args.planPath).toBe("my-plan.md");
    expect(result!.args.headless).toBe(false);
  });

  it("parses --config with short alias -c", async () => {
    const result = await parseArgs(["work", "plan.md", "-c", "flywheel.toml"]);

    expect(result).not.toBeNull();
    expect(result!.args.config).toBe("flywheel.toml");
  });

  it("parses --config with long form", async () => {
    const result = await parseArgs(["work", "plan.md", "--config", "my-config.toml"]);

    expect(result).not.toBeNull();
    expect(result!.args.config).toBe("my-config.toml");
  });

  it("parses --headless flag", async () => {
    const result = await parseArgs(["work", "plan.md", "--headless"]);

    expect(result).not.toBeNull();
    expect(result!.args.headless).toBe(true);
  });

  it("headless defaults to false", async () => {
    const result = await parseArgs(["work", "plan.md"]);

    expect(result).not.toBeNull();
    expect(result!.args.headless).toBe(false);
  });

  it("returns null for empty args", async () => {
    const result = await parseArgs([]);
    expect(result).toBeNull();
  });

  it("returns null for unknown command", async () => {
    const result = await parseArgs(["unknown-cmd"]);
    expect(result).toBeNull();
  });

  it("handles plan path with spaces", async () => {
    const result = await parseArgs(["work", "path/to/my plan.md"]);

    expect(result).not.toBeNull();
    expect(result!.args.planPath).toBe("path/to/my plan.md");
  });

  it("handles plan path with leading ./", async () => {
    const result = await parseArgs(["work", "./docs/plan.md"]);

    expect(result).not.toBeNull();
    expect(result!.args.planPath).toBe("./docs/plan.md");
  });

  it("config is undefined when not provided", async () => {
    const result = await parseArgs(["work", "plan.md"]);

    expect(result).not.toBeNull();
    expect(result!.args.config).toBeUndefined();
  });

  it("combines all options", async () => {
    const result = await parseArgs([
      "work",
      "plan.md",
      "--config",
      "flywheel.toml",
      "--headless",
    ]);

    expect(result).not.toBeNull();
    expect(result!.command).toBe("work");
    expect(result!.args.planPath).toBe("plan.md");
    expect(result!.args.config).toBe("flywheel.toml");
    expect(result!.args.headless).toBe(true);
  });
});
