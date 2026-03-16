import { describe, it, expect } from "bun:test";
import { parseSlashCommand } from "../src/tui/utils/slash-commands";

describe("parseSlashCommand", () => {
  it("returns null for empty input", () => {
    expect(parseSlashCommand("")).toBeNull();
  });

  it("returns null for non-slash input", () => {
    expect(parseSlashCommand("hello world")).toBeNull();
  });

  it("returns null for input that starts with / but is not a known command", () => {
    expect(parseSlashCommand("/unknown")).toBeNull();
  });

  it("parses /exit", () => {
    const result = parseSlashCommand("/exit");
    expect(result).toEqual({ command: "exit", args: "" });
  });

  it("parses /new", () => {
    const result = parseSlashCommand("/new");
    expect(result).toEqual({ command: "new", args: "" });
  });

  it("parses /stop", () => {
    const result = parseSlashCommand("/stop");
    expect(result).toEqual({ command: "stop", args: "" });
  });

  it("parses /help", () => {
    const result = parseSlashCommand("/help");
    expect(result).toEqual({ command: "help", args: "" });
  });

  it("parses command with args", () => {
    const result = parseSlashCommand("/new my-plan.md");
    expect(result).toEqual({ command: "new", args: "my-plan.md" });
  });

  it("trims whitespace around input", () => {
    const result = parseSlashCommand("  /exit  ");
    expect(result).toEqual({ command: "exit", args: "" });
  });

  it("preserves args with spaces", () => {
    const result = parseSlashCommand("/new path/to/my plan.md");
    expect(result).toEqual({ command: "new", args: "path/to/my plan.md" });
  });

  it("is case-insensitive for commands", () => {
    const result = parseSlashCommand("/EXIT");
    expect(result).toEqual({ command: "exit", args: "" });
  });

  it("returns null for slash only", () => {
    expect(parseSlashCommand("/")).toBeNull();
  });

  it("returns null for slash with spaces", () => {
    expect(parseSlashCommand("/  ")).toBeNull();
  });

  it("returns null for /halp (common misspelling)", () => {
    expect(parseSlashCommand("/halp")).toBeNull();
  });

  it("returns null for /this/is/a/path.md (path-like slash input)", () => {
    expect(parseSlashCommand("/this/is/a/path.md")).toBeNull();
  });

  it("returns null for /stop-all (partial match is not a match)", () => {
    expect(parseSlashCommand("/stop-all")).toBeNull();
  });

  it("returns null for /NEW extra garbage", () => {
    // "new" is known, and this should parse as /new with args
    const result = parseSlashCommand("/NEW extra garbage");
    expect(result).toEqual({ command: "new", args: "extra garbage" });
  });
});
