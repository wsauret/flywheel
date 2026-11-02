import { strField, type ToolInput } from "../detail-helpers.js";
import { normalizeSkillId } from "../../skill-id.js";
import type { ToolDisplay, ToolPresentationResolution } from "../types.js";

const PRESENTATION_NAMES = {
  save: "Save Skill",
  patch: "Patch Skill",
  remove_file: "Remove Skill File",
  archive: "Archive Skill",
  restore: "Restore Skill",
  promote: "Promote Skill",
  recommend: "Recommend Skill Promotion",
};

function isPresentationAction(action: string): action is keyof typeof PRESENTATION_NAMES {
  return action in PRESENTATION_NAMES;
}

const FILE_PRESENTATION_NAMES = {
  save: "Write Skill File",
  patch: "Patch Skill File",
};

function isFilePresentationAction(action: string): action is keyof typeof FILE_PRESENTATION_NAMES {
  return action in FILE_PRESENTATION_NAMES;
}

function skillManagePresentation(input: ToolInput): ToolPresentationResolution {
  const action = strField(input, "action") ?? "";
  const operation = isPresentationAction(action) ? PRESENTATION_NAMES[action] : undefined;
  // No known action means no operation to name: a streaming call has not said
  // yet, and a malformed historical call never did.
  if (!operation) return "input_not_ready";
  const path = strField(input, "path");
  const skill = normalizeSkillId(input.name);
  return {
    name: (path && isFilePresentationAction(action) ? FILE_PRESENTATION_NAMES[action] : undefined) ?? operation,
    detail: skill && path ? `${skill}/${path}` : (skill ?? path ?? ""),
  };
}

export const skillManageDisplay: ToolDisplay = {
  name: "skill_manage",
  action: "ui_meta",
  displayName: "Manage Skill",
  verbs: { progressive: "Managing skill", past: "Managed skill" },
  isOptimistic: false,
  preservesResultContent: true,
  getPresentation: skillManagePresentation,
};