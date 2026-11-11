import { basename } from "node:path";
import { CHECKPOINT_SECTIONS, CHECKPOINT_SECTION_TITLES } from "../../checkpoint-sections.js";
import { numField, singleLine, strField, type ToolInput } from "../detail-helpers.js";
import type { ToolDisplay } from "../types.js";
import { readDetail, readDisplay } from "./read.js";

function mutationDisplay(name: string, displayName: string, progressive: string, past: string): ToolDisplay {
  return {
    name,
    displayName,
    verbs: { progressive, past },
    action: "ui_meta",
    isOptimistic: false,
    getDetail: (input) => {
    const path = strField(input, "path");
    return path === undefined ? null : singleLine(basename(path));
    },
  };
}

/** A recorded call can name a section that this build does not know; it shows as written. */
function sectionDetail(input: ToolInput): string | null {
  const section = strField(input, "section");
  if (section === undefined) return null;
  const known = CHECKPOINT_SECTIONS.find((candidate) => candidate === section);
  return known === undefined ? section : CHECKPOINT_SECTION_TITLES[known];
}

// Historical note calls still render after the executable surface moves to checkpoints.
const mutationDisplays = [
  mutationDisplay("note_write", "Write Note", "Writing note", "Wrote note"),
  mutationDisplay("note_append", "Append Note", "Appending note", "Appended note"),
];

export const sessionNoteDisplays: readonly ToolDisplay[] = [
  { name: "checkpoint_read", action: "ui_meta", displayName: "Read Checkpoint", verbs: { progressive: "Reading checkpoint", past: "Read checkpoint" }, isOptimistic: false, preservesResultContent: true, getDetail: sectionDetail },
  { name: "checkpoint_replace", action: "ui_meta", displayName: "Update Checkpoint", verbs: { progressive: "Updating checkpoint", past: "Updated checkpoint" }, isOptimistic: false, getDetail: sectionDetail },
  { name: "checkpoint_decide", action: "ui_meta", displayName: "Record Decision", verbs: { progressive: "Recording decision", past: "Recorded decision" }, isOptimistic: false, getDetail: (input) => strField(input, "date") ?? null },
  {
    ...readDisplay,
    name: "note_read",
    action: "ui_meta",
    displayName: "Read Note",
    verbs: { progressive: "Reading note", past: "Read note" },
    getDetail: (input) => {
      const path = strField(input, "path");
      const file = path === undefined ? null : basename(path);
      const start = numField(input, "start_line");
      const stop = numField(input, "stop_line");
      if (start === undefined && stop === undefined) return readDetail(input, file);
      return singleLine(`${file}:${start ?? ""}-${stop ?? ""}`);
    },
  },
  ...mutationDisplays,
  { name: "note_list", action: "ui_meta", displayName: "List Notes", verbs: { progressive: "Listing notes", past: "Listed notes" }, isOptimistic: false, getDetail: () => null },
  { name: "note_search", action: "ui_meta", displayName: "Search Notes", verbs: { progressive: "Searching notes", past: "Searched notes" }, isOptimistic: false, getDetail: () => null },
];
