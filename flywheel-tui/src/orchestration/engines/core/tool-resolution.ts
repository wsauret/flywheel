import type { ToolAction } from "../../../infra/workflow-types.js";

type EngineToolProfile = "dispatcher_handoff" | "evaluator_verification";

const PROFILE_ACTIONS: Record<EngineToolProfile, readonly ToolAction[]> = {
  dispatcher_handoff: ["handoff_write"],
  evaluator_verification: ["file_read", "shell_exec", "file_write", "handoff_write", "file_search"],
};

const CLAUDE_ACTIONS: Record<ToolAction, readonly string[]> = {
  handoff_write: ["Write"],
  file_read: ["Read"],
  file_search: ["Grep", "Glob"],
  shell_exec: ["Bash"],
  file_write: ["Write"],
  file_edit: ["Edit"],
  task_or_progress: ["Task"],
  ask_user: ["AskUserQuestion"],
  task_delegation: [],
};

const HARNESS_ACTIONS: Record<ToolAction, readonly string[]> = {
  handoff_write: ["write_handoff"],
  file_read: ["read"],
  file_search: ["text_search", "ast_search"],
  shell_exec: ["bash"],
  file_write: ["write"],
  file_edit: ["edit"],
  task_or_progress: ["todo_list"],
  ask_user: [],
  task_delegation: ["subagent"],
};

function actionMapForEngine(engineId: string): Record<ToolAction, readonly string[]> {
  switch (engineId) {
    case "claude":
      return CLAUDE_ACTIONS;
    case "harness":
      return HARNESS_ACTIONS;
    default:
      throw new Error("Unknown engine: " + engineId);
  }
}

export function toolActionsForProfile(profile: EngineToolProfile): readonly ToolAction[] {
  return PROFILE_ACTIONS[profile];
}

export function resolveToolActions(engineId: string, actions: ReadonlyArray<ToolAction>): string[] {
  const actionMap = actionMapForEngine(engineId);
  const resolved: string[] = [];
  for (const action of actions) {
    for (const toolName of actionMap[action]) {
      if (!resolved.includes(toolName)) {
        resolved.push(toolName);
      }
    }
  }
  return resolved;
}

export function resolveToolProfile(engineId: string, profile: EngineToolProfile): string[] {
  return resolveToolActions(engineId, toolActionsForProfile(profile));
}
