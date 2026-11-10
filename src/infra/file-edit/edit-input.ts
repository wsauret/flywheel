import { readJsonValue } from "../llm/json-parse.js";
import type { StringEdit } from "./string-edit.js";

interface EditInput {
  readonly [field: string]: unknown;
}

const EDIT_ENTRY_FIELDS = ["old_string", "new_string", "replace_all"] as const;

function isEditInput(value: unknown): value is EditInput {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The replacement entries of an edit call's input as the model wrote it, read the way dispatch
 *  reads them, so every reader of a recorded or streaming call sees the entries that execution
 *  applies. The input lists them under `edits`, as a list or as the JSON text of one, and an entry
 *  can itself be JSON text; both read through the same repair tier as tool arguments. A bare entry
 *  object under `edits` is the one entry of the list. Calls recorded before 2026-11-09 hold the
 *  single-edit shape, with `old_string`, `new_string`, and `replace_all` beside `path`, and a
 *  model can still write that shape, which the edit tool reads as one entry; this reads it as
 *  that one entry too. Remove the single-edit branch after 2027-05-09 only if the edit tool no
 *  longer accepts that shape. */
export function editInputEntries(input: EditInput): readonly EditInput[] {
  const { edits } = input;
  if (edits !== undefined) {
    const value = typeof edits === "string" ? readJsonValue(edits)?.value : edits;
    const list = Array.isArray(value) ? value : isEditInput(edits) ? [edits] : [];
    return list.map((item) => typeof item === "string" ? readJsonValue(item)?.value : item).filter(isEditInput);
  }
  const entry = Object.fromEntries(EDIT_ENTRY_FIELDS.filter((field) => input[field] !== undefined).map((field) => [field, input[field]]));
  return Object.keys(entry).length > 0 ? [entry] : [];
}

/** The string edits of an `edits` list, or undefined when the list is empty or an entry lacks
 *  string text fields or has a replace_all that is not a boolean. */
export function parseStringEdits(entries: unknown): readonly StringEdit[] | undefined {
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  const edits: StringEdit[] = [];
  for (const entry of entries) {
    if (!isEditInput(entry)) return undefined;
    const { old_string: oldString, new_string: newString, replace_all: replaceAll } = entry;
    if (typeof oldString !== "string" || typeof newString !== "string" || (replaceAll !== undefined && typeof replaceAll !== "boolean")) return undefined;
    edits.push({ oldString, newString, ...(replaceAll === true ? { replaceAll } : {}) });
  }
  return edits;
}
