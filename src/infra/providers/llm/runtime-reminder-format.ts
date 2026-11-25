import type { ConversationMessage } from "./conversation/conversation-message.js";

// The text format of the runtime reminders that history holds: what the producer
// (`createReminders`) writes and what every reader of history parses back.

export const ENVIRONMENT_HEADER = "# Runtime environment";
export const ENVIRONMENT_CHANGE_HEADER = "# Runtime environment change";

export const label = {
  platform: "Platform", osVersion: "OS release", shell: "Shell", workingDirectory: "Working directory",
  previousWorkingDirectory: "Previous working directory", gitRepo: "Git repository", worktree: "Linked git worktree",
} as const;

export function escapeEnvironment(value: string): string {
  return value.replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    // oxlint-disable-next-line no-control-regex -- boundary: filesystem and environment text can hold control characters, and each value must stay on its own line.
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, (character) => `&#${character.charCodeAt(0)};`);
}

// The inverse of escapeEnvironment on its output. A raw "&lt;" decodes to "<", which escapes back to the same text,
// so a decoded value always renders the bytes it was read from.
function decodeEnvironment(value: string): string {
  return value.replace(/&lt;|&gt;|&#(\d+);/g, (entity, code: string | undefined) => {
    if (code === undefined) return entity === "&lt;" ? "<" : ">";
    const point = Number(code);
    return point <= 0x1f || (point >= 0x7f && point <= 0x9f) || point === 0x2028 || point === 0x2029 ? String.fromCharCode(point) : entity;
  });
}

/** A model id without the extended-context suffix that the engine spells the extended window with (`engineModelId`). */
export function withoutExtendedWindow(modelId: string): string {
  return modelId.replace(/\[1m\]$/i, "");
}

export const MODEL_OPENING = "The model that answers ";

/**
 * The facts that one runtime reminder states. Environment text is decoded from the reminder's escaping, so
 * escaping it again gives the reminder's bytes. A working directory can hold the redaction marker, because history
 * stores redacted reminders.
 */
export type RuntimeReminder =
  | {
    readonly kind: "environment"; readonly workingDirectory: string; readonly isWorktree: boolean; readonly isGitRepo: boolean;
    readonly platform: string; readonly osVersion: string;
    /** Absent when the reminder was written for an agent without the shell. */
    readonly shell?: string;
  }
  /** Holds only the facts that changed. */
  | { readonly kind: "environment-update"; readonly workingDirectory?: string; readonly isWorktree?: boolean; readonly isGitRepo?: boolean }
  /** `contextWindow` is absent in the wording of builds before 2026-11-11, which stated no window. */
  | { readonly kind: "model"; readonly text: string; readonly modelId: string; readonly displayName?: string; readonly knowledgeCutoff?: string; readonly contextWindow?: number }
  | { readonly kind: "date"; readonly date: string; readonly changed: boolean };

export const fact = (name: string, value: string) => ` - ${name}: ${value}`;
export const yesNo = (value: boolean) => (value ? "yes" : "no");
export const worktreeLine = { yes: fact(label.worktree, "yes"), no: fact(label.worktree, "no") } as const;

export function dateText(date: string, changed: boolean): string {
  return changed
    ? `The local date is now ${date}. The user's clock already shows it, so use the new date without remarking on the change.`
    : `Current local date: ${date}.`;
}

/** One reminder format: the headers and fact lines that one generation of the producer wrote. */
interface EnvironmentFormat {
  readonly opening: string;
  readonly change: string;
  readonly workingDirectory: string;
  readonly platform: string;
  readonly shell: string;
  readonly osVersion: string;
  /** The git state that a line states, with or without its earlier value. */
  gitRepo(line: string): boolean | undefined;
  /** The worktree state that a line states. */
  worktree(line: string): boolean | undefined;
  /** The new working directory of a change line's value, given the directory that history held before. */
  changedDirectory(value: string, previous: string | undefined): string;
}

const currentGitLine = new RegExp(`^ - ${label.gitRepo}: (yes|no)(?: \\(before: (?:yes|no)\\))?$`);

const CURRENT_FORMAT: EnvironmentFormat = {
  opening: ENVIRONMENT_HEADER, change: ENVIRONMENT_CHANGE_HEADER,
  workingDirectory: label.workingDirectory, platform: label.platform, shell: label.shell, osVersion: label.osVersion,
  gitRepo: (line) => {
    const value = currentGitLine.exec(line)?.[1];
    return value === undefined ? undefined : value === "yes";
  },
  worktree: (line) => (line === worktreeLine.yes ? true : line === worktreeLine.no ? false : undefined),
  changedDirectory: (value) => decodeEnvironment(value),
};

// Builds before 2026-10-27 wrote the environment reminders in an earlier format, and conversation history keeps them.
// That format named the working directory, git state, platform, shell, and OS version with other labels, marked a
// worktree only by a guidance line about it, and wrote a changed working directory followed by " (was <old>)". Remove
// this format and `parseLegacyDate` after 2027-04-27.
const LEGACY_FORMAT: EnvironmentFormat = {
  opening: "# Environment", change: "# Environment update",
  workingDirectory: "Primary working directory", platform: "Platform", shell: "Shell", osVersion: "OS Version",
  gitRepo: (line) => {
    const value = /^ - Is a git repository: (true|false)(?: \(was (?:true|false)\))?$/.exec(line)?.[1];
    return value === undefined ? undefined : value === "true";
  },
  worktree: (line) => (line.startsWith(" - Primary working directory: ") || !line.includes("git worktree") ? undefined : !line.includes("no longer")),
  changedDirectory: (value, previous) => {
    // " (was " can occur inside either path, so only the known previous directory separates the two.
    const suffix = previous === undefined ? undefined : ` (was ${escapeEnvironment(previous)})`;
    return decodeEnvironment(suffix !== undefined && value.endsWith(suffix) ? value.slice(0, -suffix.length) : value);
  },
};

const environmentValue = (name: string, line: string) => line.startsWith(` - ${name}: `) ? line.slice(name.length + 5) : undefined;

function parseEnvironment(lines: readonly string[], format: EnvironmentFormat): RuntimeReminder | undefined {
  let workingDirectory: string | undefined;
  let git: boolean | undefined;
  let worktree: boolean | undefined;
  let platform: string | undefined;
  let shell: string | undefined;
  let osVersion: string | undefined;
  for (const line of lines.slice(1)) {
    workingDirectory ??= environmentValue(format.workingDirectory, line);
    git ??= format.gitRepo(line);
    worktree ??= format.worktree(line);
    platform ??= environmentValue(format.platform, line);
    shell ??= environmentValue(format.shell, line);
    osVersion ??= environmentValue(format.osVersion, line);
  }
  if (workingDirectory === undefined || git === undefined || platform === undefined || osVersion === undefined) return undefined;
  return {
    kind: "environment", workingDirectory: decodeEnvironment(workingDirectory), isWorktree: worktree === true, isGitRepo: git,
    platform: decodeEnvironment(platform), ...(shell === undefined ? {} : { shell: decodeEnvironment(shell) }), osVersion: decodeEnvironment(osVersion),
  };
}

function parseEnvironmentChange(lines: readonly string[], format: EnvironmentFormat, previousWorkingDirectory: string | undefined): RuntimeReminder {
  let workingDirectory: string | undefined;
  let gitRepo: boolean | undefined;
  let worktree: boolean | undefined;
  for (const line of lines.slice(1)) {
    const changed = environmentValue(format.workingDirectory, line);
    if (changed !== undefined) workingDirectory = format.changedDirectory(changed, previousWorkingDirectory);
    gitRepo = format.gitRepo(line) ?? gitRepo;
    worktree = format.worktree(line) ?? worktree;
  }
  return {
    kind: "environment-update",
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
    ...(gitRepo === undefined ? {} : { isGitRepo: gitRepo }),
    ...(worktree === undefined ? {} : { isWorktree: worktree }),
  };
}

const CONTEXT_WINDOW_SENTENCE = String.raw`(?: Its context window holds ([\d,]+) tokens\.)?`;
const NAMED_MODEL = new RegExp(String.raw`^The model that answers is (.+), with the model ID (\S+)\.(?: Its training data ends in (.+?)\.)?${CONTEXT_WINDOW_SENTENCE}$`);
const PLAIN_MODEL = new RegExp(String.raw`^The model that answers has the model ID (\S+)\.${CONTEXT_WINDOW_SENTENCE}$`);

const contextWindowOf = (tokens: string | undefined) => tokens === undefined ? {} : { contextWindow: Number(tokens.replaceAll(",", "")) };

function parseModel(body: string): RuntimeReminder | undefined {
  const named = NAMED_MODEL.exec(body);
  // SAFETY: groups 1 and 2 of the pattern are not optional, so a match captured both.
  if (named) return { kind: "model", text: body, modelId: named[2]!, displayName: named[1]!, ...(named[3] === undefined ? {} : { knowledgeCutoff: named[3] }), ...contextWindowOf(named[4]) };
  const plain = PLAIN_MODEL.exec(body);
  // SAFETY: group 1 of the pattern is not optional, so a match captured it.
  return plain ? { kind: "model", text: body, modelId: plain[1]!, ...contextWindowOf(plain[2]) } : parseLegacyModel(body);
}

/** A model reminder in the format of builds before 2026-10-27, which stated the display name, the model ID, and the
 *  knowledge cutoff in other sentences. Remove this reader after 2027-04-27. */
function parseLegacyModel(body: string): RuntimeReminder | undefined {
  const named = /^You are powered by the model named (.+?)\. The exact model ID is (.+?)\.(?: Assistant knowledge cutoff is (.+)\.)?$/.exec(body);
  // SAFETY: groups 1 and 2 of the pattern are not optional, so a match captured both.
  if (named) return { kind: "model", text: body, modelId: named[2]!, displayName: named[1]!, ...(named[3] === undefined ? {} : { knowledgeCutoff: named[3] }) };
  const plain = /^You are powered by the model (\S+)\.$/.exec(body);
  // SAFETY: group 1 of the pattern is not optional, so a match captured it.
  return plain ? { kind: "model", text: body, modelId: plain[1]! } : undefined;
}

function parseDate(body: string): RuntimeReminder | undefined {
  const date = /\d{4}-\d{2}-\d{2}/.exec(body)?.[0];
  if (date === undefined) return undefined;
  for (const changed of [false, true]) if (body === dateText(date, changed)) return { kind: "date", date, changed };
  return parseLegacyDate(body);
}

/** A date reminder in the format of builds before 2026-10-27 (`LEGACY_FORMAT`): a changed date adds "now" and a
 *  sentence before and after the date. */
function parseLegacyDate(body: string): RuntimeReminder | undefined {
  const legacy = /^(?:[^.\n]+\. )?Today's date is (now )?(\d{4}-\d{2}-\d{2})\.(?: [^\n]*)?$/.exec(body);
  // SAFETY: group 2 of the pattern is not optional, so a match captured it.
  return legacy ? { kind: "date", date: legacy[2]!, changed: legacy[1] !== undefined } : undefined;
}

/**
 * Reads the facts of one reminder entry that a route's reminders (`createReminders`) wrote, from its tagged content, in the current
 * format or the format of earlier builds that history still holds. Returns undefined for any other text. An
 * environment change of an earlier build wrote the new working directory followed by the old one, so the caller
 * passes the working directory that history held before the change. Without it, that change's working directory
 * holds both.
 */
export function parseRuntimeReminder(content: string, previousWorkingDirectory?: string): RuntimeReminder | undefined {
  const body = /^<system-reminder>\n([\s\S]*)\n<\/system-reminder>\n?$/.exec(content)?.[1];
  if (body === undefined) return undefined;
  const lines = body.split("\n");
  for (const format of [CURRENT_FORMAT, LEGACY_FORMAT]) {
    if (lines[0] === format.opening) return parseEnvironment(lines, format);
    if (lines[0] === format.change) return parseEnvironmentChange(lines, format, previousWorkingDirectory);
  }
  if (body.startsWith(MODEL_OPENING) || body.startsWith("You are powered by the model ")) return parseModel(body);
  return parseDate(body);
}

export function reminderIn(message: ConversationMessage, previousWorkingDirectory?: string): RuntimeReminder | undefined {
  if (message.kind !== "user" || message.origin !== "system" || typeof message.content !== "string") return undefined;
  return parseRuntimeReminder(message.content, previousWorkingDirectory);
}

/** Whether `content` is a model reminder that names `model`, as a request's history target names the model that
 *  serves it (`ProviderHistoryTarget.model`). The engine's spelling of the extended window names the same model. */
export function isModelReminderOf(content: string, model: string): boolean {
  const reminder = parseRuntimeReminder(content);
  return reminder?.kind === "model" && withoutExtendedWindow(reminder.modelId) === withoutExtendedWindow(model);
}
