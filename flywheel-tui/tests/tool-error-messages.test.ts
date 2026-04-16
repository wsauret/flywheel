import { describe, expect, test } from "bun:test";
import { extractErrorText, launderToolError } from "../src/infra/output/output-formatter.js";

describe("launderToolError", () => {
  test("InputValidationError is extracted and labeled with tool name", () => {
    const raw = "<tool_use_error>InputValidationError: missing file_path</tool_use_error>";
    expect(launderToolError(raw, "Edit")).toBe("Edit failed — invalid input: missing file_path");
  });

  test("generic tool_use_error is extracted with tool name prefix", () => {
    const raw = "<tool_use_error>File not found: /tmp/foo.ts</tool_use_error>";
    expect(launderToolError(raw, "Edit")).toBe("Edit failed — File not found: /tmp/foo.ts");
  });

  test("no-such-tool error extracts the tool name", () => {
    const raw = "Error: No such tool available: FooTool";
    expect(launderToolError(raw)).toBe("Tool not available: FooTool");
  });

  test("sensitive file edit is rejected with path", () => {
    const raw = "Claude requested permissions to edit /Users/me/.zshrc which is a sensitive file.";
    expect(launderToolError(raw, "Edit")).toBe("Edit rejected — /Users/me/.zshrc is a protected file");
  });

  test("sensitive file write is rejected with path", () => {
    const raw = "Claude requested permissions to write to /Users/me/.bashrc which is a sensitive file.";
    expect(launderToolError(raw, "Edit")).toBe("Write rejected — /Users/me/.bashrc is a protected file");
  });

  test("sensitive file read is rejected with path", () => {
    const raw = "Claude requested permissions to read from /Users/me/.ssh/id_rsa which is a sensitive file.";
    expect(launderToolError(raw, "Edit")).toBe("Read rejected — /Users/me/.ssh/id_rsa is a protected file");
  });

  test("unknown error falls back to tool name", () => {
    expect(launderToolError("some unknown error text", "Edit")).toBe("Edit failed");
  });

  test("unknown error without tool name falls back to 'Tool failed'", () => {
    expect(launderToolError("some unknown error text")).toBe("Tool failed");
  });

  test("InputValidationError takes precedence over generic tool_use_error", () => {
    const raw = "<tool_use_error>InputValidationError: bad param</tool_use_error>";
    expect(launderToolError(raw, "Write")).toBe("Write failed — invalid input: bad param");
  });
});

describe("extractErrorText", () => {
  test("returns string content as-is", () => {
    expect(extractErrorText("the error")).toBe("the error");
  });

  test("extracts text from array content", () => {
    const content = [{ type: "text", text: "the error" }];
    expect(extractErrorText(content)).toBe("the error");
  });

  test("returns undefined for undefined input", () => {
    expect(extractErrorText(undefined)).toBeUndefined();
  });

  test("returns undefined for empty array", () => {
    expect(extractErrorText([])).toBeUndefined();
  });

  test("returns undefined for array without text items", () => {
    const content = [{ type: "image", url: "http://example.com" }];
    expect(extractErrorText(content)).toBeUndefined();
  });

  test("extracts first text item from mixed array", () => {
    const content = [
      { type: "image", url: "http://example.com" },
      { type: "text", text: "found it" },
    ];
    expect(extractErrorText(content)).toBe("found it");
  });
});
