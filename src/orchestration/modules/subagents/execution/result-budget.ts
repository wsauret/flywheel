/**
 * Bounds the whole result a subagent returns before it enters the parent's
 * context. This module is the one place that cuts a subagent result.
 *
 * The parent context is the long-lived expensive one: every later parent
 * call carries again whatever a child returned. The cap is the MIN of a
 * static ceiling and a share of what the parent's one context admission
 * budget has left, divided across the completion batch, so many parallel
 * children and the parent's own tool batch cannot together push the parent's
 * next planned save past its window (ARCH-CONTEXT-029). Every cut keeps a
 * head and a tail, saves the full content to a session breadcrumb file, and
 * states what was cut and where the full content is.
 */

import { displayRelativePath } from "../../../../infra/tools/detail-helpers.js";
import { Log } from "../../../../infra/log.js";
import { truncateHeadTail } from "../../../../infra/output/truncate-output.js";
import { limitOutput } from "../../../agent-runtime/compaction/truncation.js";
import { saveFullOutput } from "../../../agent-runtime/tools/output-breadcrumb.js";

interface HandoffContent {
  [key: string]: unknown;
}

const log = Log.create({ service: "subagent-result-budget" });

// Hard per-result character ceiling layered on top of the dynamic headroom
// budget. Belt-and-suspenders for models that ignore concision instructions.
export const MAX_RESULT_CHARS = 24_000;
// Fraction of the parent's remaining admission budget that the whole batch of
// subagent results may consume. The per-result budget is this slice divided
// across the batch, so N children cannot collectively overflow the parent.
const RESULT_HEADROOM_FRACTION = 0.5;
// Floor so a single result always gets a usable slice even when the parent
// is nearly full. Below this we would be truncating to noise.
const MIN_RESULT_CHARS = 2_000;
// The key the runtime adds to a cut handoff to name what it cut.
const MARKER = "truncated";

/** Per-result character cap: MIN of the static ceiling and the result's
 *  slice of `remainingChars`, what the parent's admission budget has left.
 *  A parent without that budget gets the ceiling alone. */
export function resultCharBudget(remainingChars: number | undefined, batchSize: number): number {
  if (remainingChars === undefined) return MAX_RESULT_CHARS;
  const perResultChars = Math.floor(remainingChars * RESULT_HEADROOM_FRACTION / Math.max(1, batchSize));
  return Math.min(MAX_RESULT_CHARS, Math.max(MIN_RESULT_CHARS, perResultChars));
}

/** The bound of one subagent result and where its cut content is saved. */
export interface ResultBudget {
  /** Characters the parent reads of this result, from `resultCharBudget`. */
  cap: number;
  executionCwd: string;
  projectRoot: string;
  /** Breadcrumb tree the full content is saved into. */
  artifactScopeId: string;
  /** Breadcrumb filename prefix so saved files are attributable per persona. */
  agentType: string;
}

/** Where the full content of a cut handoff is, or that it could not be saved. */
type SavedLocation = { full_handoff_path: string } | { full_handoff_unsaved: true };

/** Serializes a handoff for the parent within `budget.cap` characters.
 *  A handoff that fits is returned as its exact pretty JSON. Otherwise the
 *  full handoff is saved once and the result stays valid JSON with one added
 *  `truncated` key that names the cut fields and the saved file. The cap is
 *  first shared across the top-level fields, which keep their order: small
 *  fields stay whole, a string over its share keeps its head and tail, and
 *  any other value becomes an omission note. When the fields cannot each
 *  keep a note within the cap, only the summary's head and tail remain, and
 *  the marker names the other fields, or counts them when their names do not
 *  fit. The bound holds unless the saved file's path alone is longer than
 *  the cap. A child field named `truncated` is always cut, so the marker
 *  cannot hide it. */
export async function boundHandoff(handoff: HandoffContent, budget: ResultBudget): Promise<string> {
  const full = JSON.stringify(handoff, null, 2);
  if (full.length <= budget.cap) return full;

  const saved = await saveFullOutput(full, `subagent-handoff-${budget.agentType}`, budget.projectRoot, budget.artifactScopeId);
  const location: SavedLocation = saved
    ? { full_handoff_path: displayRelativePath(saved, budget.executionCwd) }
    : { full_handoff_unsaved: true };
  const byField = boundFields(handoff, budget.cap, location);
  const text = byField ?? boundToSummary(handoff, budget.cap, location);
  log.info("subagent handoff bounded", {
    agentType: budget.agentType, cap: budget.cap, originalChars: full.length, boundedChars: text.length,
    form: byField ? "fields" : "summary", saved: saved !== null,
  });
  return text;
}

/** Bounds a text result with the same head and tail cut and breadcrumb as
 *  every truncated tool result. The parent can read the result long after it
 *  dispatched, when its tools may have changed, so the notice names the saved
 *  file and no tool. */
export async function boundText(text: string, budget: ResultBudget): Promise<string> {
  if (text.length <= budget.cap) return text;
  // UTF-8 bytes never number fewer than characters, so a byte cap bounds characters too.
  const limited = await limitOutput({
    content: text,
    maxBytes: budget.cap,
    executionCwd: budget.executionCwd,
    projectRoot: budget.projectRoot,
    artifactScopeId: budget.artifactScopeId,
    toolName: `subagent-${budget.agentType}`,
  });
  log.info("subagent text result bounded", {
    agentType: budget.agentType, cap: budget.cap, originalChars: text.length, boundedChars: limited.text.length,
    saved: limited.fullContentPath !== undefined,
  });
  return limited.text;
}

/** The handoff with every field kept whole, cut, or replaced by a note, or
 *  undefined when that form cannot fit the cap. Fields are shared out
 *  smallest first. A string over its share waits for the room that the
 *  fields after it leave, so a large value that becomes a short note gives
 *  its share back to the strings that need it. */
function boundFields(handoff: HandoffContent, cap: number, location: SavedLocation): string | undefined {
  const keys = Object.keys(handoff).filter((key) => key !== MARKER);
  const cut = new Set(keys.length < Object.keys(handoff).length ? [MARKER] : []);
  // Reserve the marker as if every field were cut, so the cut fields always fit.
  const markerSize = entrySize(MARKER, { fields: [...cut, ...keys], ...location });
  // "{\n" and "\n}", plus ",\n" between the fields and the marker.
  let remaining = cap - (4 + 2 * keys.length) - markerSize;

  const bounded = new Map<string, unknown>();
  const waiting: Array<{ key: string; size: number; value: string }> = [];
  const bySize = keys.map((key) => ({ key, size: entrySize(key, handoff[key]) })).sort((a, b) => a.size - b.size);
  for (const [index, field] of bySize.entries()) {
    const value = handoff[field.key];
    const share = Math.floor(remaining / (bySize.length - index + waiting.length));
    let kept: unknown = value;
    if (field.size > share) {
      if (typeof value === "string") {
        waiting.push({ ...field, value });
        continue;
      }
      kept = omittedNote(value);
      cut.add(field.key);
    }
    bounded.set(field.key, kept);
    remaining -= entrySize(field.key, kept);
  }
  for (const [index, { key, size, value }] of waiting.entries()) {
    const share = Math.floor(remaining / (waiting.length - index));
    const kept = size <= share ? value : cutString(key, value, share) ?? omittedNote(value);
    if (kept !== value) cut.add(key);
    bounded.set(key, kept);
    remaining -= entrySize(key, kept);
  }

  const marker = { fields: [...cut].sort((a, b) => keys.indexOf(a) - keys.indexOf(b)), ...location };
  const text = JSON.stringify(Object.fromEntries([...keys.map((key) => [key, bounded.get(key)]), [MARKER, marker]]), null, 2);
  return text.length <= cap ? text : undefined;
}

/** The handoff reduced to the summary's head and tail and one marker that
 *  names every other field, or counts them when the names would take more
 *  than half the cap. */
function boundToSummary(handoff: HandoffContent, cap: number, location: SavedLocation): string {
  const keys = Object.keys(handoff);
  const named = entrySize(MARKER, { fields: keys, ...location }) <= cap / 2;
  const marker = (cut: string[]) => named ? { fields: cut, ...location } : { field_count: cut.length, ...location };
  // "{\n", ",\n", and "\n}" around the summary and the marker.
  const room = cap - 6 - entrySize(MARKER, marker(keys));
  const summary = handoff.summary;
  const kept = typeof summary !== "string" ? undefined : entrySize("summary", summary) <= room ? summary : cutString("summary", summary, room);
  if (kept === undefined) return JSON.stringify({ [MARKER]: marker(keys) }, null, 2);
  const cut = keys.filter((key) => key !== "summary" || kept !== summary);
  return JSON.stringify({ summary: kept, [MARKER]: marker(cut) }, null, 2);
}

/** Characters one field occupies in the pretty JSON, from its indent to its value's end. */
function entrySize(key: string, value: unknown): number {
  return JSON.stringify({ [key]: value }, null, 2).length - 4;
}

function omittedNote(value: unknown): string {
  return `[omitted: ${JSON.stringify(value, null, 2).length} chars; see full handoff]`;
}

/** The head and tail of `value` whose entry under `key` fits `share`
 *  characters, or undefined when no head and tail fit. */
function cutString(key: string, value: string, share: number): string | undefined {
  const room = share - entrySize(key, "");
  // Scale the raw target by the escape ratio, then shrink it by any overshoot
  // that the head and tail still carry in escapes and the omission marker.
  let target = Math.floor(room * value.length / (JSON.stringify(value).length - 2));
  while (target > 0) {
    const kept = truncateHeadTail(value, target).text;
    const overshoot = entrySize(key, kept) - share;
    if (overshoot <= 0) return kept;
    target -= overshoot;
  }
  return undefined;
}
