import { describe, expect, test } from "bun:test";
import { toolScopingToActions } from "../src/infra/workflow-types";
import { resolveToolActions, resolveToolProfile, toolActionsForProfile } from "../src/orchestration/engines/core/tool-resolution";

describe("engine tool resolution", () => {
  test("dispatcher profile resolves to the per-engine handoff mechanism", () => {
    expect(toolActionsForProfile("dispatcher_handoff")).toEqual(["handoff_write"]);
    expect(resolveToolProfile("claude", "dispatcher_handoff")).toEqual(["Write"]);
    expect(resolveToolProfile("harness", "dispatcher_handoff")).toEqual(["write_handoff"]);
  });

  test("evaluator profile preserves existing effective tool breadth", () => {
    expect(resolveToolProfile("claude", "evaluator_verification")).toEqual(["Read", "Bash", "Write", "Grep", "Glob"]);
    expect(resolveToolProfile("harness", "evaluator_verification")).toEqual(["read", "bash", "write", "write_handoff", "text_search", "ast_search"]);
  });

  test("worker scoping keeps Claude provider-native tool names", () => {
    const actions = toolScopingToActions({ read: true, bash: true, write: false, edit: false, task: false });
    expect(actions).toEqual(["file_read", "shell_exec", "handoff_write"]);
    expect(resolveToolActions("claude", actions)).toEqual(["Read", "Bash", "Write"]);
  });

  test("worker read scope keeps harness read and handoff", () => {
    const actions = toolScopingToActions({ read: true, bash: false, write: false, edit: false, task: false });
    expect(resolveToolActions("harness", actions)).toEqual(["read", "write_handoff"]);
  });

  test("ask_user only resolves on Claude", () => {
    expect(resolveToolActions("claude", ["ask_user"])).toEqual(["AskUserQuestion"]);
    expect(resolveToolActions("harness", ["ask_user"])).toEqual([]);
  });
});
