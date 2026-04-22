import { describe, expect, test } from "bun:test";
import { getEngine } from "../src/orchestration/engines/core/registry";

import "../src/orchestration/engines/register-all";

describe("engine parity metadata", () => {
  test("claude records provider-session parity traits", () => {
    const engine = getEngine("claude");
    expect(engine.metadata.parity).toEqual({
      resumeMode: "provider_session",
      handoffMode: "generic_file_write",
      progressMode: "builtin_todo",
      toolExecutionMode: "provider_native",
      taskScopeMode: "subagent",
      supportsExternalToolResults: true,
    });
  });

  test("harness records shell-emulated parity traits", () => {
    const engine = getEngine("harness");
    expect(engine.metadata.parity).toEqual({
      resumeMode: "local_transcript",
      handoffMode: "dedicated_handoff_tool",
      progressMode: "stateful_progress_tool",
      toolExecutionMode: "shell_emulated",
      taskScopeMode: "progress_tool",
      supportsExternalToolResults: false,
    });
  });
});
