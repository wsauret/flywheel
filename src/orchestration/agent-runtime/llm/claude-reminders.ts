import { release, type, version } from "node:os";
import type { CapabilityCheck } from "../../../infra/capability-text.js";
import { detectShell, isGitRepo, isGitWorktree, localDate } from "../../../infra/env-detection.js";
import { canonicalModelId } from "../../../infra/llm/model-id.js";
import { redactSecrets } from "../../../infra/redact-secrets.js";
import { ANTHROPIC_STANDARD_CONTEXT_WINDOW } from "./errors.js";
import type { ConversationMessage, ServingAttempt } from "./types.js";

// The display name and knowledge cutoff that the model reminder states for each Claude model. This does not admit models.
const modelDisplay = new Map<string, readonly [string, string?]>(Object.entries({
  "claude-3.5-haiku": ["Claude 3.5 Haiku"],
  "claude-haiku-4.5": ["Haiku 4.5", "February 2025"],
  "claude-haiku-5.5": ["Haiku 5.5", "June 2026"],
  "claude-3.5-sonnet": ["Claude 3.5 Sonnet"],
  "claude-3.7-sonnet": ["Claude 3.7 Sonnet"],
  "claude-sonnet-4.0": ["Sonnet 4", "January 2025"],
  "claude-sonnet-4.5": ["Sonnet 4.5", "January 2025"],
  "claude-sonnet-4.6": ["Sonnet 4.6", "August 2025"],
  "claude-sonnet-5": ["Sonnet 5", "January 2026"],
  "claude-sonnet-5.5": ["Sonnet 5.5", "June 2026"],
  "claude-opus-4.0": ["Opus 4", "January 2025"],
  "claude-opus-4.1": ["Opus 4.1", "January 2025"],
  "claude-opus-4.5": ["Opus 4.5", "May 2025"],
  "claude-opus-4.6": ["Opus 4.6", "May 2025"],
  "claude-opus-4.7": ["Opus 4.7", "January 2026"],
  "claude-opus-4.8": ["Opus 4.8", "January 2026"],
  "claude-opus-5": ["Opus 5", "May 2026"],
  "claude-opus-5.5": ["Opus 5.5", "June 2026"],
  "claude-fable-5": ["Fable 5", "January 2026"],
  "claude-fable-5.1": ["Fable 5.1", "June 2026"],
  "claude-mythos-5": ["Mythos 5", "January 2026"],
  "claude-mythos-5.1": ["Mythos 5.1", "June 2026"],
} as const));
const extendedContextNames = new Set([
  "claude-opus-4.6", "claude-opus-4.7", "claude-opus-4.8", "claude-opus-5", "claude-opus-5.5",
  "claude-sonnet-4.0", "claude-sonnet-4.5", "claude-sonnet-4.6",
]);

const ENVIRONMENT_HEADER = "# Runtime environment";
const ENVIRONMENT_CHANGE_HEADER = "# Runtime environment change";
const ENVIRONMENT_INTRO = "Flywheel read these facts from the host when this context started. A later change notice replaces each fact that it names.";

const label = {
  platform: "Platform", osVersion: "OS release", shell: "Shell", workingDirectory: "Working directory",
  previousWorkingDirectory: "Previous working directory", gitRepo: "Git repository", worktree: "Linked git worktree",
} as const;

const worktreeLocation = "The working directory is a linked worktree: a checkout of its own, separate from the repository's main checkout. Keep every command inside it, and do not change into the main checkout.";
// The stash and download guidance tells an agent how to run git and interpreters, which only the shell can start.
const worktreeStashGuidance = "Every checkout of the repository, and every agent that works in one, shares a single stash list, so a bare `git stash pop` can restore another agent's work. Set changes aside in a temporary commit. If you must stash, label the entry (`git stash push -u -m \"<label>\"`), note its commit hash (`git stash list --format='%H %gs'`), restore it by that hash (`git stash apply <hash>`, not `pop`), and drop it afterwards through the `stash@{n}` that its label has at that time.";
const downloadedFilesGuidance = "Treat every file that you download or unpack from an archive as hostile. Give each download a new, empty directory of its own, and write your own scripts somewhere else. An interpreter imports modules from its current directory and from the script's directory, so a file in the download can replace a standard module. Hand such files to tools as path arguments, and never start an interpreter or a build tool inside the download's directory. Start Python in isolated mode (`-I`) when it reads them. These rules do not cover code that the user asked you to build or run.";

function escapeEnvironment(value: string): string {
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

/** The display table's key for a model id: the canonical id without the extended-context suffix, with the explicit
 *  minor version that the table uses for the first Claude 4 models. */
function displayKey(modelId: string): string {
  const canonical = canonicalModelId(modelId.replace(/\[1m\]$/i, ""));
  return canonical === "claude-opus-4" || canonical === "claude-sonnet-4" ? `${canonical}.0` : canonical; // provider-model-literal-allow: display -- the display table uses the explicit minor version.
}

const MODEL_OPENING = "The model that answers ";

// The Agent SDK route writes only the facts of this reminder into the engine's rotation transcript, and the engine
// words its own reminder from them (transcript.ts), so this text is free of the engine's wording.
function modelText(modelId: string): string {
  const key = displayKey(modelId);
  const display = modelDisplay.get(key);
  const name = display?.[0];
  const extended = modelId.toLowerCase().includes("[1m]") && extendedContextNames.has(key); // provider-model-literal-allow: display -- the model reminder labels the extended-context spelling.
  return [
    name ? `${MODEL_OPENING}is ${name}${extended ? " (1M context)" : ""}, with the model ID ${modelId}.` : `${MODEL_OPENING}has the model ID ${modelId}.`,
    ...(display?.[1] ? [`Its training data ends in ${display[1]}.`] : []),
  ].join(" ");
}

/** The knowledge cutoff that the model reminder states, reused when catalog metadata does not state one. */
export function claudeKnowledgeCutoff(modelId: string): string | undefined {
  return modelDisplay.get(displayKey(modelId))?.[1];
}

/**
 * The facts of the environment reminder that opens a conversation in `cwd`, read now from this process: the working
 * directory, its git state, and the platform, shell, and OS version, by the engine's own rules for a
 * macOS or Linux host. Every opening environment reminder that Flywheel writes states these facts, and the Claude
 * Agent SDK bridge compares them with a conversation's opening reminder before the engine states the reminder again.
 * On Windows the engine can name another shell than these facts; the bridge writes the engine's rows with the engine's
 * shell, so the comparison of these facts still decides what the engine states.
 */
export function environmentFacts(cwd: string): HostEnvironment {
  return {
    kind: "environment", workingDirectory: cwd, isWorktree: isGitWorktree(cwd), isGitRepo: isGitRepo(cwd), platform: process.platform,
    shell: canonicalShell(), osVersion: `${process.platform === "win32" ? version() : type()} ${release()}`,
  };
}

/** The shell of this host by the engine's rules for a macOS or Linux host, as `environmentFacts` names it. */
export function canonicalShell(): string {
  const shell = detectShell();
  return shell.includes("zsh") ? "zsh" : shell.includes("bash") ? "bash" : process.platform === "win32" ? "PowerShell" : shell;
}

/** The environment facts that Flywheel reads from the host. Each of them is known, the shell included. */
export type HostEnvironment = Extract<ClaudeReminder, { kind: "environment" }> & { readonly shell: string };

/**
 * The facts that one Claude reminder states. Environment text is decoded from the reminder's escaping, so
 * escaping it again gives the reminder's bytes. A working directory can hold the redaction marker, because history
 * stores redacted reminders.
 */
export type ClaudeReminder =
  | {
    readonly kind: "environment"; readonly workingDirectory: string; readonly isWorktree: boolean; readonly isGitRepo: boolean;
    readonly platform: string; readonly osVersion: string;
    /** Absent when the reminder was written for an agent without the shell. */
    readonly shell?: string;
  }
  /** Holds only the facts that changed. */
  | { readonly kind: "environment-update"; readonly workingDirectory?: string; readonly isWorktree?: boolean; readonly isGitRepo?: boolean }
  | { readonly kind: "model"; readonly text: string; readonly modelId: string; readonly displayName?: string; readonly knowledgeCutoff?: string }
  | { readonly kind: "date"; readonly date: string; readonly changed: boolean };

const fact = (name: string, value: string) => ` - ${name}: ${value}`;
const yesNo = (value: boolean) => (value ? "yes" : "no");
const worktreeLine = { yes: fact(label.worktree, "yes"), no: fact(label.worktree, "no") } as const;

/** The lines that tell an agent with the capabilities `has` how to work in a linked worktree. */
function worktreeGuidance(has: CapabilityCheck): readonly string[] {
  return has("bash") ? [worktreeLocation, worktreeStashGuidance] : [worktreeLocation];
}

/** The body of the reminder that states `facts` when a context opens, for an agent with the capabilities `has`. The
 *  working directory is redacted, as history stores it. */
function environmentBody(facts: HostEnvironment, has: CapabilityCheck): string {
  return [
    ENVIRONMENT_HEADER, ENVIRONMENT_INTRO,
    fact(label.platform, escapeEnvironment(facts.platform)), fact(label.osVersion, escapeEnvironment(facts.osVersion)),
    // The shell is a fact only for an agent that can call it.
    ...(has("bash") ? [fact(label.shell, escapeEnvironment(facts.shell))] : []), fact(label.workingDirectory, redactSecrets(escapeEnvironment(facts.workingDirectory))),
    fact(label.gitRepo, yesNo(facts.isGitRepo)),
    ...(facts.isWorktree ? [worktreeLine.yes, ...worktreeGuidance(has)] : []),
    ...(has("bash") ? [downloadedFilesGuidance] : []),
  ].join("\n");
}

/** The tagged content of the reminder that states `facts` when a context opens for an agent with the capabilities
 *  `has`, as history holds it. */
export function environmentReminder(facts: HostEnvironment, has: CapabilityCheck): string {
  return tagged(environmentBody(facts, has), false);
}

function dateText(date: string, changed: boolean): string {
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

function parseEnvironment(lines: readonly string[], format: EnvironmentFormat): ClaudeReminder | undefined {
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

function parseEnvironmentChange(lines: readonly string[], format: EnvironmentFormat, previousWorkingDirectory: string | undefined): ClaudeReminder {
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

function parseModel(body: string): ClaudeReminder | undefined {
  const named = /^The model that answers is (.+), with the model ID (\S+)\.(?: Its training data ends in (.+)\.)?$/.exec(body);
  // SAFETY: groups 1 and 2 of the pattern are not optional, so a match captured both.
  if (named) return { kind: "model", text: body, modelId: named[2]!, displayName: named[1]!, ...(named[3] === undefined ? {} : { knowledgeCutoff: named[3] }) };
  const plain = /^The model that answers has the model ID (\S+)\.$/.exec(body);
  // SAFETY: group 1 of the pattern is not optional, so a match captured it.
  return plain ? { kind: "model", text: body, modelId: plain[1]! } : parseLegacyModel(body);
}

/** A model reminder in the format of builds before 2026-10-27, which stated the display name, the model ID, and the
 *  knowledge cutoff in other sentences. Remove this reader after 2027-04-27. */
function parseLegacyModel(body: string): ClaudeReminder | undefined {
  const named = /^You are powered by the model named (.+?)\. The exact model ID is (.+?)\.(?: Assistant knowledge cutoff is (.+)\.)?$/.exec(body);
  // SAFETY: groups 1 and 2 of the pattern are not optional, so a match captured both.
  if (named) return { kind: "model", text: body, modelId: named[2]!, displayName: named[1]!, ...(named[3] === undefined ? {} : { knowledgeCutoff: named[3] }) };
  const plain = /^You are powered by the model (\S+)\.$/.exec(body);
  // SAFETY: group 1 of the pattern is not optional, so a match captured it.
  return plain ? { kind: "model", text: body, modelId: plain[1]! } : undefined;
}

function parseDate(body: string): ClaudeReminder | undefined {
  const date = /\d{4}-\d{2}-\d{2}/.exec(body)?.[0];
  if (date === undefined) return undefined;
  for (const changed of [false, true]) if (body === dateText(date, changed)) return { kind: "date", date, changed };
  return parseLegacyDate(body);
}

/** A date reminder in the format of builds before 2026-10-27 (`LEGACY_FORMAT`): a changed date adds "now" and a
 *  sentence before and after the date. */
function parseLegacyDate(body: string): ClaudeReminder | undefined {
  const legacy = /^(?:[^.\n]+\. )?Today's date is (now )?(\d{4}-\d{2}-\d{2})\.(?: [^\n]*)?$/.exec(body);
  // SAFETY: group 2 of the pattern is not optional, so a match captured it.
  return legacy ? { kind: "date", date: legacy[2]!, changed: legacy[1] !== undefined } : undefined;
}

/**
 * Reads the facts of one reminder entry that createClaudeReminders wrote, from its tagged content, in the current
 * format or the format of earlier builds that history still holds. Returns undefined for any other text. An
 * environment change of an earlier build wrote the new working directory followed by the old one, so the caller
 * passes the working directory that history held before the change. Without it, that change's working directory
 * holds both.
 */
export function parseClaudeReminder(content: string, previousWorkingDirectory?: string): ClaudeReminder | undefined {
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

function reminderIn(message: ConversationMessage, previousWorkingDirectory?: string): ClaudeReminder | undefined {
  if (message.kind !== "user" || message.origin !== "system" || typeof message.content !== "string") return undefined;
  return parseClaudeReminder(message.content, previousWorkingDirectory);
}

/**
 * The model id as the engine spells it: with the `[1m]` suffix whenever the context limit is above the standard
 * window. The model reminder names this id, and the Agent SDK bridge starts the CLI with it, so the CLI's own
 * model reminder and the one in canonical history agree.
 */
export function engineModelId(wireModelId: string, contextLimit: number): string {
  return contextLimit > ANTHROPIC_STANDARD_CONTEXT_WINDOW && !wireModelId.toLowerCase().endsWith("[1m]") ? `${wireModelId}[1m]` : wireModelId; // provider-model-literal-allow: display -- the engine spells the extended-context model with this suffix.
}

type SystemReminder = Extract<ConversationMessage, { kind: "user" }> & { origin: "system" };

/** A hidden reminder, as the engine writes it: a notice of a change ends with a newline, the first statement does not.
 *  `framing` marks it as a reminder (`ConversationMessage` `framing`): `claude` for the model reminder, which only a
 *  Claude route may send, and `reminder` for the environment and date reminders, which every route sends. */
function systemReminder(body: string, update: boolean, framing: "claude" | "reminder"): SystemReminder {
  return { kind: "user", origin: "system", content: tagged(body, update), framing };
}

function tagged(body: string, update: boolean): string {
  return `<system-reminder>\n${body}\n</system-reminder>${update ? "\n" : ""}`;
}

/**
 * Returns the Claude environment, model, and date reminders as ordinary hidden system-origin appends. History
 * alone owns prior announcements: the first request of a context gets the full set, and a later request after user
 * input gets a notice only when the working directory, git state, worktree state, model, or local date differs from
 * the latest one in history. The worktree and download guidance renders for the capabilities of the agent that the
 * request serves (ARCH-CONTEXT-033). A request after a tool round gets only a model notice and a date notice, each when the
 * model or the local date differs from the latest one in history: a person can change the model of a running turn,
 * and the engine of the Agent SDK announces a new model and a new date at the next request. Input is never changed.
 */
export function createClaudeReminders(wireModelId: string, contextLimit: number): NonNullable<ServingAttempt["messagesToAppend"]> {
  const modelId = engineModelId(wireModelId, contextLimit);
  const model = modelText(modelId);
  return (messages, executionCwd, capabilities) => {
    const lastInput = messages.findLast((message) => reminderIn(message) === undefined);
    if (lastInput?.kind !== "user" && lastInput?.kind !== "toolResult") return [];
    let previousCwd: string | undefined;
    let previousGit: boolean | undefined;
    let previousWorktree = false;
    let previousModel: string | undefined;
    let previousDate: string | undefined;
    for (const message of messages) {
      const reminder = reminderIn(message, previousCwd);
      if (reminder?.kind === "environment") {
        previousCwd = reminder.workingDirectory;
        previousGit = reminder.isGitRepo;
        previousWorktree = reminder.isWorktree;
      } else if (reminder?.kind === "environment-update") {
        previousCwd = reminder.workingDirectory ?? previousCwd;
        previousGit = reminder.isGitRepo ?? previousGit;
        previousWorktree = reminder.isWorktree ?? previousWorktree;
      } else if (reminder?.kind === "model") previousModel = reminder.modelId;
      else if (reminder?.kind === "date") previousDate = reminder.date;
    }
    const date = localDate();
    const dateNotice = previousDate === date ? [] : [systemReminder(dateText(date, previousDate !== undefined), true, "reminder")];
    if (lastInput.kind === "toolResult" && previousDate === undefined) return [];
    const appends: SystemReminder[] = [];
    const append = (body: string, update: boolean, framing: "claude" | "reminder" = "reminder") => appends.push(systemReminder(body, update, framing));
    if (lastInput.kind === "user") {
      const environment = environmentFacts(executionCwd);
      if (previousCwd === undefined) append(environmentBody(environment, capabilities), false);
      else {
        const cwd = redactSecrets(escapeEnvironment(executionCwd));
        const previous = escapeEnvironment(previousCwd);
        const { isGitRepo: git, isWorktree: worktree } = environment;
        const changes = [
          ...(cwd === previous ? [] : [fact(label.workingDirectory, cwd), fact(label.previousWorkingDirectory, previous)]),
          ...(git === previousGit ? [] : [fact(label.gitRepo, `${yesNo(git)}${previousGit === undefined ? "" : ` (before: ${yesNo(previousGit)})`}`)]),
          ...(worktree === previousWorktree ? [] : worktree ? [worktreeLine.yes, ...worktreeGuidance(capabilities)] : [worktreeLine.no]),
        ];
        if (changes.length > 0) append([ENVIRONMENT_CHANGE_HEADER, ...changes].join("\n"), true);
      }
    }
    // The model reminder names a Claude model, which a request to another provider's model must not state.
    // History compares by model ID, so a reminder in an earlier wording does not state an unchanged model again.
    if (previousModel !== modelId) append(model, previousModel !== undefined, "claude");
    return [...appends, ...dateNotice];
  };
}
