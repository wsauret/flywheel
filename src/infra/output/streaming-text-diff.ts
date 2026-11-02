import type { ToolStreamingText } from "../output-blocks.js";
import type { EditableValue, ValueEdit, ValuePath } from "./output-block-delta.js";

/** Past this many edits one value ships whole: a change that touches this much
 *  of the value is a rewrite, and shipping it whole says so more cheaply. */
const MAX_EDITS = 64;
/** How much of the new tail anchors the search for where an old tail slid to. */
const WINDOW_PROBE_CHARS = 64;

/** The smallest edits that turn one tool's last shipped streaming entry into
 *  its current one, or undefined when the entry must ship whole: it changed
 *  kind (input text, execution output, proposed diff, preview advice), or the
 *  change is a rewrite rather than growth. */
export function diffStreamingEntry(prev: ToolStreamingText, next: ToolStreamingText): readonly ValueEdit[] | undefined {
  return entryKind(prev) === entryKind(next) ? diffValues(prev, next) : undefined;
}

/** The smallest edits that turn the copy last shipped into the current value,
 *  or undefined when the change is a rewrite that ships whole. No edits means
 *  the two are equal.
 *
 *  Live values grow at their ends. Tool input, a shell header, and execution
 *  output are strings that gain a suffix, or, once a bounded output tail
 *  fills, lose a prefix too. A proposed diff is a tree whose files, hunks, and
 *  lines carry stable ids and gain lines at the end while the last line's text
 *  grows. The diff walks both versions together and names exactly those
 *  changes, so a change costs what it adds instead of the size of everything
 *  accumulated. */
export function diffValues(prev: EditableValue, next: EditableValue): readonly ValueEdit[] | undefined {
  const edits: ValueEdit[] = [];
  diffValue(prev, next, [], edits);
  return edits.length > MAX_EDITS ? undefined : edits;
}

function entryKind(entry: ToolStreamingText): "content" | "proposedDiff" | "previewCheck" {
  if (entry.proposedDiff !== undefined) return "proposedDiff";
  if (entry.previewCheck !== undefined) return "previewCheck";
  return "content";
}

function diffValue(prev: EditableValue, next: EditableValue, path: ValuePath, edits: ValueEdit[]): void {
  if (prev === next) return;
  if (typeof prev === "string" && typeof next === "string") {
    diffString(prev, next, path, edits);
    return;
  }
  if (isArray(prev) && isArray(next)) {
    diffArray(prev, next, path, edits);
    return;
  }
  if (isObject(prev) && isObject(next)) {
    diffObject(prev, next, path, edits);
    return;
  }
  edits.push({ kind: "assign", path, value: next });
}

function diffString(prev: string, next: string, path: ValuePath, edits: ValueEdit[]): void {
  if (next.startsWith(prev)) {
    edits.push({ kind: "append", path, offset: prev.length, text: next.slice(prev.length) });
    return;
  }
  const drop = slidTo(prev, next);
  if (drop === undefined) {
    edits.push({ kind: "assign", path, value: next });
    return;
  }
  edits.push({ kind: "window", path, offset: prev.length, drop, text: next.slice(prev.length - drop) });
}

/** Where a bounded tail that lost its front now starts: the shortest dropped
 *  prefix whose remainder the new tail begins with. Undefined when the new
 *  value is not the old one slid forward. */
function slidTo(prev: string, next: string): number | undefined {
  const probe = next.slice(0, WINDOW_PROBE_CHARS);
  if (probe.length === 0) return undefined;
  // A kept remainder at least as long as the probe contains it, so the probe
  // finds every such start without comparing at each offset.
  for (let at = prev.indexOf(probe, 1); at !== -1 && prev.length - at >= probe.length; at = prev.indexOf(probe, at + 1)) {
    if (next.startsWith(prev.slice(at))) return at;
  }
  // A shorter remainder is compared directly, within the probe's reach.
  for (let at = Math.max(1, prev.length - probe.length + 1); at < prev.length; at += 1) {
    if (next.startsWith(prev.slice(at))) return at;
  }
  return undefined;
}

function diffArray(prev: readonly EditableValue[], next: readonly EditableValue[], path: ValuePath, edits: ValueEdit[]): void {
  if (next.length < prev.length) {
    edits.push({ kind: "assign", path, value: next });
    return;
  }
  for (let index = 0; index < prev.length; index += 1) {
    const before = prev[index];
    const after = next[index];
    if (before === undefined || after === undefined) continue;
    // An element with another identity is a different line or hunk: editing
    // it field by field would describe a change that never happened.
    if (identity(before) !== identity(after)) edits.push({ kind: "assign", path: [...path, index], value: after });
    else diffValue(before, after, [...path, index], edits);
  }
  if (next.length > prev.length) edits.push({ kind: "push", path, length: prev.length, items: next.slice(prev.length) });
}

function diffObject(prev: EditableObject, next: EditableObject, path: ValuePath, edits: ValueEdit[]): void {
  for (const [key, after] of Object.entries(next)) {
    if (after === undefined) continue;
    const before = prev[key];
    if (before === undefined) edits.push({ kind: "assign", path: [...path, key], value: after });
    else diffValue(before, after, [...path, key], edits);
  }
  for (const [key, before] of Object.entries(prev)) {
    if (before !== undefined && next[key] === undefined) edits.push({ kind: "delete", path: [...path, key] });
  }
}

function identity(value: EditableValue): string | undefined {
  return isObject(value) && typeof value.id === "string" ? value.id : undefined;
}

function isArray(value: EditableValue): value is readonly EditableValue[] {
  return Array.isArray(value);
}

type EditableObject = { readonly [key: string]: EditableValue | undefined };

function isObject(value: EditableValue): value is EditableObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
