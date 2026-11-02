import { describe, expect, test } from "bun:test";
import { extractErrorText, formatAgentFailureDisplay, launderToolError } from "../../../../src/infra/output/output-formatter.js";
import { formatToolInputProblems } from "../../../../src/orchestration/agent-runtime/tools/validate-input.js";

describe("launderToolError", () => {
  test.each([
    "Memory at 1,409/1,500 chars. Adding this entry (159 chars) would exceed the limit by 68 chars. Free at least that much.",
    "Replacement would put memory at 1,568/1,500 chars - over the limit by 68 chars. Remove stale entries.",
    "After applying all 2 operations, memory would be at 1,568/1,500 chars - over the limit by 68 chars. Remove more entries.",
  ])("curates memory capacity failures without exposing the recovery envelope: %s", (error) => {
    expect(launderToolError(JSON.stringify({ success: false, error, current_entries: ["Private memory."] })))
      .toBe("Memory update exceeds the limit by 68 characters");
  });

  test("extracts the error from a JSON tool result before curating it", () => {
    expect(launderToolError(JSON.stringify({ success: false, error: "old_text cannot be empty." })))
      .toBe("Old_text cannot be empty");
  });

  test.each(['{"error":', '{"error":42}', '{"error":""}'])("does not show an unreadable error envelope: %s", (raw) => {
    expect(launderToolError(raw)).toBe("Tool failed");
  });

  test("InputValidationError is extracted without a redundant verb prefix", () => {
    const raw = "<tool_use_error>InputValidationError: missing file_path</tool_use_error>";
    expect(launderToolError(raw)).toBe("Invalid input: missing file_path");
  });

  test("generic tool_use_error is surfaced as the bare cause", () => {
    const raw = "<tool_use_error>File not found: /tmp/foo.ts</tool_use_error>";
    expect(launderToolError(raw)).toBe("File not found: /tmp/foo.ts");
  });

  test("no-such-tool error extracts the tool name", () => {
    const raw = "Error: No such tool available: FooTool";
    expect(launderToolError(raw)).toBe("Tool not available: FooTool");
  });

  test("sensitive file edit is rejected with path", () => {
    const raw = "Claude requested permissions to edit /Users/me/.zshrc which is a sensitive file.";
    expect(launderToolError(raw)).toBe("Edit rejected: /Users/me/.zshrc is a protected file");
  });

  test("sensitive file write is rejected with path", () => {
    const raw = "Claude requested permissions to write to /Users/me/.bashrc which is a sensitive file.";
    expect(launderToolError(raw)).toBe("Write rejected: /Users/me/.bashrc is a protected file");
  });

  test("sensitive file read is rejected with path", () => {
    const raw = "Claude requested permissions to read from /Users/me/.ssh/id_rsa which is a sensitive file.";
    expect(launderToolError(raw)).toBe("Read rejected: /Users/me/.ssh/id_rsa is a protected file");
  });

  test("unknown error surfaces the bare cause, capitalized", () => {
    expect(launderToolError("some unknown error text")).toBe("Some unknown error text");
  });

  test("empty error falls back to a bare 'Failed'", () => {
    expect(launderToolError("")).toBe("Failed");
    expect(launderToolError("   \n  ")).toBe("Failed");
  });

  test("drops a trailing instruction sentence from any error without a dedicated pattern", () => {
    const raw = "Connection refused on port 5432. Check that the database is running and retry.";
    expect(launderToolError(raw)).toBe("Connection refused on port 5432");
  });

  test("read failure surfaces the concise cause, dropping the verb, path lead and syscall tail", () => {
    const raw =
      "Failed to read 'src/tui/adapters/output-formatter.ts': ENOENT: no such file or directory, open '/Users/me/flywheel/src/tui/adapters/output-formatter.ts'. Common causes: file does not exist, permission denied, or the path points at a directory.";
    expect(launderToolError(raw)).toBe("No such file or directory");
  });

  test("peels stacked edit-rejection leads and trailing parenthetical, leaving the bare cause", () => {
    const raw =
      "Edit failed: Edit rejected: 6 anchors do not match the current file (marked *).\nThe edit was NOT applied, please use the updated file content shown below, and issue another edit tool-call.";
    expect(launderToolError(raw)).toBe("6 anchors do not match the current file");
  });

  test("search path-not-found drops the trailing resolved-path parenthetical", () => {
    const raw =
      "search path 'src/foo' does not exist (resolved to /Users/me/proj/src/foo). Check the directory name and retry; the project root is /Users/me/proj.";
    expect(launderToolError(raw)).toBe("Search path 'src/foo' does not exist");
  });

  test("bash interception surfaces the actionable tool to use instead of the buried preamble", () => {
    const raw =
      "Command intercepted: a dedicated tool exists for this operation. Use the `list` tool instead. Example: list(path=\"...\", pattern=\"**/*.ts\")";
    expect(launderToolError(raw)).toBe("Use the list tool instead");
  });

  test("unknown tool surfaces just the tool name, dropping the troubleshooting tail", () => {
    const raw =
      "Unknown tool 'write' — this tool is not registered in the current session. Available tools: bash, read, list. Either you misspelled the tool name or the tool is not loaded.";
    expect(launderToolError(raw)).toBe("Unknown tool 'write'");
  });


  test("embedded-tag handoff rejection drops the trailing remediation sentences", () => {
    const raw =
      "Your `summary` value contains an embedded tag (`</invoke>`), which means the entire handoff collapsed into a single argument. Each handoff field must be its own top-level JSON argument.";
    const result = launderToolError(raw);
    expect(result.startsWith("Your `summary` value contains an embedded tag")).toBe(true);
  });

  test("truncates a single overlong sentence at the length cap", () => {
    const raw = `${"x".repeat(200)} still going`;
    const result = launderToolError(raw);
    expect(result.endsWith("…")).toBe(true);
    expect(result.length).toBeLessThan(80);
  });

});

describe("formatAgentFailureDisplay", () => {
  test("tells the agent to correct invalid tool input without suggesting a model change", () => {
    const failure = formatAgentFailureDisplay(
      formatToolInputProblems("subagent", ["The required parameter `kind` is missing"]),
    );

    expect(failure).toEqual({
      title: "Subagent failed",
      message: "Invalid input: The required parameter `kind` is missing",
      guidance: "Correct the tool input and retry.",
    });
  });

  test("preserves complete validation details without headline truncation", () => {
    const problem = "Parameter `kind` must be one of: dispatch, steer, resume, retry";
    const failure = formatAgentFailureDisplay(formatToolInputProblems("subagent", [problem]));

    expect(failure.message).toBe(`Invalid input: ${problem}`);
  });

  test("uses cause-neutral guidance for a generic failure", () => {
    const failure = formatAgentFailureDisplay("Subagent failed because its workspace disappeared.");

    expect(failure.guidance).toBe("Send a message to retry.");
    expect(failure.guidance).not.toContain("/model");
    expect(failure.action).toBeUndefined();
  });
});

describe("extractErrorText", () => {
  test("returns undefined for array without text items", () => {
    const content = [{ type: "image" as const, mediaType: "image/png", data: "abc" }];
    expect(extractErrorText(content)).toBeUndefined();
  });

  test("extracts first text item from mixed array", () => {
    const content = [
      { type: "image" as const, mediaType: "image/png", data: "abc" },
      { type: "text" as const, text: "found it" },
    ];
    expect(extractErrorText(content)).toBe("found it");
  });
});
