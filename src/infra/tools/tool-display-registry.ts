/**
 * Canonical display lookup for tool names. Per-tool ToolDisplay contracts
 * live in `displays/<name>.ts`; this module is their single registration
 * root. Adding a known display means importing it here and adding it to
 * the BUILT_IN array.
 *
 * Every tool Flywheel ships has an entry here, and a test holds that. Only a
 * tool Flywheel does not own (an MCP tool, or a name from an older history)
 * gets the fallback display, synthesized on first lookup and cached: a
 * command row named by the raw tool name.
 */

import { canonicalize } from "../canonical-name.js";
import { stripAnsiEscapes } from "../control-characters.js";
import { isRecord } from "../record.js";
import { isHandoffPath } from "../paths.js";
import { buildDisplay, defaultDetailFromInput } from "./build-display.js";
import { strField, type ToolInput } from "./detail-helpers.js";
import { askUserDisplay } from "./displays/ask-user.js";
import { bashDisplay } from "./displays/bash.js";
import { codeDisplay } from "./displays/code.js";
import { papercutDisplay, papercutDisposeDisplay } from "./displays/papercut.js";
import { experimentDisplays } from "./displays/experiment.js";
import { definitionOverridesDisplay } from "./displays/definition-overrides.js";
import { iosSimulatorDisplay } from "./displays/ios-simulator.js";
import { editDisplay } from "./displays/edit.js";
import { listDisplay } from "./displays/list.js";
import { readDisplay } from "./displays/read.js";
import { searchDisplay } from "./displays/search.js";
import { recallDisplay } from "./displays/recall.js";
import { mcpSearchDisplay } from "./displays/mcp-search.js";
import { mcpCallDisplay } from "./displays/mcp-call.js";
import { webDisplay } from "./displays/web.js";
import { workflowDisplay } from "./displays/workflow.js";
import { skillDisplay } from "./displays/skill.js";
import { memoryDisplay } from "./displays/memory.js";
import { sessionNoteDisplays } from "./displays/session-note.js";
import { skillManageDisplay } from "./displays/skill-manage.js";
import { stepDisplay } from "./displays/step.js";
import { subagentDisplay } from "./displays/subagent.js";
import { writeDisplay } from "./displays/write.js";
import { handoffDisplay } from "./displays/handoff.js";
import { historicalBackgroundDisplay } from "./displays/background.js";
import { processDisplay } from "./displays/process.js";
import { listSessionsDisplay, messageSessionDisplay } from "./displays/message-session.js";
import { modelsDisplay } from "./displays/models.js";
import { benchmarkDisplay } from "./displays/benchmark.js";
import type { ToolDisplay, ToolPresentation, ToolPresentationContext } from "./types.js";

const BUILT_IN: readonly ToolDisplay[] = [
  readDisplay,
  writeDisplay,
  editDisplay,
  bashDisplay,
  codeDisplay,
  papercutDisplay,
  papercutDisposeDisplay,
  ...experimentDisplays,
  definitionOverridesDisplay,
  iosSimulatorDisplay,
  searchDisplay,
  recallDisplay,
  mcpSearchDisplay,
  mcpCallDisplay,
  webDisplay,
  listDisplay,
  handoffDisplay,
  subagentDisplay,
  workflowDisplay,
  stepDisplay,
  skillDisplay,
  skillManageDisplay,
  memoryDisplay,
  ...sessionNoteDisplays,
  askUserDisplay,
  historicalBackgroundDisplay,
  processDisplay,
  messageSessionDisplay,
  listSessionsDisplay,
  modelsDisplay,
  benchmarkDisplay,
];

const displays = new Map<string, ToolDisplay>([
  ...BUILT_IN.map((display): [string, ToolDisplay] => [canonicalize(display.name), display]),
  // Remove after 2027-10-30: transcripts that builds before 2026-10-30 wrote for gpt-6-luna hold `exec` shell calls.
  ["exec", bashDisplay],
  ["apply_patch", editDisplay],
]);
const fallbacks = new Map<string, ToolDisplay>();

interface ToolRowPresentation {
  readonly presentation: ToolPresentation;
  readonly sentence: ToolPresentation;
}

export function getToolDisplay(name: string): ToolDisplay {
  const cn = canonicalize(name);
  return displays.get(cn) ?? fallbacks.get(cn) ?? synthesizeFallback(cn, name);
}

export function getToolDisplayName(name: string, input?: unknown): string {
  const cn = canonicalize(name);
  if ((cn === "write" || cn === "edit") && isRecord(input) && isHandoffPath(strField(input, "path"))) return "Write Handoff";
  // mcp__* names get their "MCP <server>" label from synthesizeFallback.
  return getToolDisplay(name).displayName;
}

/** The row field a call's input declares about mutating project files. Live,
 *  streamed, reopened, and child-session rows all derive it here, so a shell
 *  mutation reads as file changes on every path that builds its row. */
export function declaredMutationField(toolName: string, input: unknown): { readonly declaresMutation?: true } {
  return isRecord(input) && getToolDisplay(toolName).declaresMutation?.(input) === true ? { declaresMutation: true } : {};
}

/** Whether a call is transcript-hidden plumbing. Live, streamed, and
 *  reopened rows all decide it here. */
export function isHiddenFromTranscript(display: ToolDisplay, input: unknown): boolean {
  const hidden = display.hiddenFromTranscript;
  return typeof hidden === "function" ? hidden(isRecord(input) ? input : {}) : hidden === true;
}

/** The row field that states the session a call addresses. Live, streamed,
 *  reopened, and child-session rows all derive it here, so the transcript
 *  projection names the row by that session's current title on every path. */
export function targetSessionField(toolName: string, input: unknown): { readonly targetSessionId?: string } {
  const target = isRecord(input) ? getToolDisplay(toolName).targetSession?.(input) : undefined;
  return target === undefined ? {} : { targetSessionId: target };
}

/** Single boundary from a tool invocation to its canonical presentation. The
 *  raw tool name stays the machine identity; this returns what the user reads.
 *  Status and result metadata are deliberately not inputs: a row keeps one
 *  name while pending, completed, failed, blocked, or interrupted. A call whose
 *  input names no operation yet still gets the neutral family name, so every
 *  placed row has one. */
export function resolveToolPresentation(toolName: string, input: unknown, executionCwd: string, context?: ToolPresentationContext): ToolPresentation {
  const resolved = resolvePresentationIfReady(toolName, input, executionCwd, context);
  return resolved ?? { name: sanitizePresentationText(getToolDisplayName(toolName, isRecord(input) ? input : {})), detail: "" };
}

/** Derive a transcript row and its workflow sentence from the same invocation. */
export function resolveToolRowPresentation(toolName: string, input: unknown, executionCwd: string, context?: ToolPresentationContext): ToolRowPresentation {
  const presentation = resolveToolPresentation(toolName, input, executionCwd, context);
  const display = getToolDisplay(toolName);
  const sentence = display.getSentence?.(isRecord(input) ? input : {}, executionCwd, presentation)
    ?? { name: display.verbs.past, detail: presentation.detail };
  return { presentation, sentence: sanitizePresentation(sentence) };
}

/** Resolve declared fields when available. Callers must not use absence to
 * decide whether a transcript row exists. */
export function resolvePresentationIfReady(toolName: string, input: unknown, executionCwd: string, context?: ToolPresentationContext): ToolPresentation | null {
  const record = isRecord(input) ? input : {};
  const display = getToolDisplay(toolName);
  if (display.getPresentation) {
    const resolved = display.getPresentation(record, executionCwd, context);
    return resolved === "input_not_ready" ? null : sanitizePresentation(resolved);
  }
  const detail = display.getDetail(record, executionCwd);
  return detail ? sanitizePresentation({ name: getToolDisplayName(toolName, record), detail }) : null;
}

/** Bidi formatting controls: they reorder the rest of a row's text around them,
 *  so a name or detail carrying one can present as text it does not contain.
 *  Other `Cf` characters stay: a zero-width joiner is part of an emoji. */
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/** Reduce one presentation string to a single logical display line. ANSI, OSC,
 *  and C1 escape sequences go first, because their bytes only read as controls
 *  as a sequence; the remaining C0/C1 controls, line and paragraph separators,
 *  and every other whitespace run then fold to one space. Ordinary punctuation
 *  is untouched, so a search-style detail still reads exactly as written. */
function sanitizePresentationText(raw: string): string {
  return stripAnsiEscapes(raw)
    .replace(BIDI_CONTROLS, "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, " ")
    .trim();
}

function sanitizePresentation(presentation: ToolPresentation): ToolPresentation {
  return { name: sanitizePresentationText(presentation.name), detail: sanitizePresentationText(presentation.detail) };
}

/** An unregistered tool by its server and tool name, such as `linear.get_issue`. */
function callLabel(cn: string, originalName: string): string {
  return cn.startsWith("mcp__") ? cn.slice(5).split("__").join(".") : originalName;
}

const SUBJECT_KEYS = ["id", "query", "q", "promql", "name", "title", "path", "url", "subject"];
const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What an unregistered call acts on: a field that names its subject, else
 *  its first short string that is not an opaque id such as a tenant UUID. */
function callSubject(input: ToolInput): string | undefined {
  for (const key of SUBJECT_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return Object.values(input).find((value): value is string => typeof value === "string" && value !== "" && value.length <= 120 && !OPAQUE_ID.test(value));
}

function synthesizeFallback(cn: string, originalName: string): ToolDisplay {
  const displayName = cn.startsWith("mcp__") ? `MCP ${cn.slice(5).split("__")[0]}` : originalName;
  const display = buildDisplay({
    name: cn,
    action: "shell_exec",
    preservesResultContent: true,
    displayName,
    verbs: { progressive: "running", past: "Ran" },
    getDetail: defaultDetailFromInput,
    getSentence: (input) => {
      const subject = callSubject(input);
      return { name: "Called", detail: `${callLabel(cn, originalName)}${subject === undefined ? "" : ` ${subject}`}` };
    },
  });
  fallbacks.set(cn, display);
  return display;
}
