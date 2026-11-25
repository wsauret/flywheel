import { release, type, version } from "node:os";
import type { CapabilityCheck } from "../../../../infra/capability-text.js";
import { detectShell, isGitRepo, isGitWorktree, localDate } from "../../../../infra/env-detection.js";
import { canonicalModelId } from "../../../../infra/model-id.js";
import type { ModelInfo } from "../../../../infra/llm/models/models.js";
import { redactSecrets } from "../../../../infra/redact-secrets.js";
import { ANTHROPIC_STANDARD_CONTEXT_WINDOW } from "../errors.js";
import type { ServingAttempt } from "../types.js";
import type { ConversationMessage } from "../../../../infra/llm/conversation/conversation-message.js";
import { dateText, ENVIRONMENT_CHANGE_HEADER, ENVIRONMENT_HEADER, escapeEnvironment, fact, label, MODEL_OPENING, reminderIn, withoutExtendedWindow, worktreeLine, yesNo, type RuntimeReminder } from "../../../../infra/llm/runtime-reminder-format.js";

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
  "claude-fable-5.2": ["Fable 5.2", "June 2026"],
  "claude-mythos-5": ["Mythos 5", "January 2026"],
  "claude-mythos-5.1": ["Mythos 5.1", "June 2026"],
  "claude-mythos-5.2": ["Mythos 5.2", "June 2026"],
} as const));
const extendedContextNames = new Set([
  "claude-opus-4.6", "claude-opus-4.7", "claude-opus-4.8", "claude-opus-5", "claude-opus-5.5",
  "claude-sonnet-4.0", "claude-sonnet-4.5", "claude-sonnet-4.6",
]);

const ENVIRONMENT_INTRO = "Flywheel read these facts from the host when this context started. A later change notice replaces each fact that it names.";


const worktreeLocation = "The working directory is a linked worktree: a checkout of its own, separate from the repository's main checkout. Keep every command inside it, and do not change into the main checkout.";
// The stash and download guidance tells an agent how to run git and interpreters, which only the shell can start.
const worktreeStashGuidance = "Every checkout of the repository, and every agent that works in one, shares a single stash list, so a bare `git stash pop` can restore another agent's work. Set changes aside in a temporary commit. If you must stash, label the entry (`git stash push -u -m \"<label>\"`), note its commit hash (`git stash list --format='%H %gs'`), restore it by that hash (`git stash apply <hash>`, not `pop`), and drop it afterwards through the `stash@{n}` that its label has at that time.";
const downloadedFilesGuidance = "Treat every file that you download or unpack from an archive as hostile. Give each download a new, empty directory of its own, and write your own scripts somewhere else. An interpreter imports modules from its current directory and from the script's directory, so a file in the download can replace a standard module. Hand such files to tools as path arguments, and never start an interpreter or a build tool inside the download's directory. Start Python in isolated mode (`-I`) when it reads them. These rules do not cover code that the user asked you to build or run.";


/** The display table's key for a model id: the canonical id without the extended-context suffix, with the explicit
 *  minor version that the table uses for the first Claude 4 models. */
function displayKey(modelId: string): string {
  const canonical = canonicalModelId(withoutExtendedWindow(modelId));
  return canonical === "claude-opus-4" || canonical === "claude-sonnet-4" ? `${canonical}.0` : canonical; // provider-model-literal-allow: display -- the display table uses the explicit minor version.
}


/** The catalog facts that name a model the display table does not know. */
type ModelCatalogFacts = Pick<ModelInfo, "name" | "knowledgeCutoff">;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

/** A catalog cutoff ("2026-06" or "2026-06-30") in the table's spelling ("June 2026"). Other text passes unchanged. */
function catalogCutoff(cutoff: string): string {
  const [, year, month] = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(cutoff) ?? [];
  const name = MONTHS[Number(month) - 1];
  return name ? `${name} ${year}` : cutoff;
}

/** The name and cutoff that the reminder states: the display table's entry, else the model's own catalog facts in the
 *  table's spelling, never an earlier version's. The "(1M context)" label stays with the table, because the engine
 *  labels only the models that it names that way. */
function modelIdentity(key: string, catalog: ModelCatalogFacts | undefined) {
  const display = modelDisplay.get(key);
  if (display) return { name: display[0], cutoff: display[1], labelsExtended: extendedContextNames.has(key) };
  const cutoff = catalog?.knowledgeCutoff;
  return { name: catalog?.name.replace(/^Claude /, ""), cutoff: cutoff ? catalogCutoff(cutoff) : undefined, labelsExtended: false };
}

// The Agent SDK route writes only the facts of this reminder into the engine's rotation transcript, and the engine
// words its own reminder from them (transcript.ts), so this text is free of the engine's wording. The engine's facts
// hold no window, so on that route only the engine's "(1M context)" label and model ID state it.
function modelText(modelId: string, catalog: ModelCatalogFacts | undefined, contextWindow: number): string {
  const { name, cutoff, labelsExtended } = modelIdentity(displayKey(modelId), catalog);
  const extended = labelsExtended && modelId.toLowerCase().includes("[1m]"); // provider-model-literal-allow: display -- the model reminder labels the extended-context spelling.
  return [
    name ? `${MODEL_OPENING}is ${name}${extended ? " (1M context)" : ""}, with the model ID ${modelId}.` : `${MODEL_OPENING}has the model ID ${modelId}.`,
    ...(cutoff ? [`Its training data ends in ${cutoff}.`] : []),
    `Its context window holds ${contextWindow.toLocaleString("en-US")} tokens.`,
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
export type HostEnvironment = Extract<RuntimeReminder, { kind: "environment" }> & { readonly shell: string };


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



/**
 * The model id as the engine spells it: with the `[1m]` suffix whenever the context limit is above the standard
 * window. The model reminder names this id, and the Agent SDK bridge starts the CLI with it, so the CLI's own
 * model reminder and the one in canonical history agree.
 */
export function engineModelId(wireModelId: string, contextLimit: number): string {
  return contextLimit > ANTHROPIC_STANDARD_CONTEXT_WINDOW && !wireModelId.toLowerCase().endsWith("[1m]") ? `${wireModelId}[1m]` : wireModelId; // provider-model-literal-allow: display -- the engine spells the extended-context model with this suffix.
}

type SystemReminder = Extract<ConversationMessage, { kind: "user" }> & { origin: "system" };

/** The framing of a model reminder: `claude` for a Claude route's, which an Anthropic Messages request to the model
 *  that it names reads, and `model` for every other route's, which any request to the model that it names reads
 *  (`provider-history.ts`). */
type ModelFraming = "claude" | "model";

/** A hidden reminder, as the engine writes it: a notice of a change ends with a newline, the first statement does not.
 *  `framing` marks it as a reminder (`ConversationMessage` `framing`): a `ModelFraming` for the model reminder, and
 *  `reminder` for the environment and date reminders, which every request reads. */
function systemReminder(body: string, update: boolean, framing: ModelFraming | "reminder"): SystemReminder {
  return { kind: "user", origin: "system", content: tagged(body, update), framing };
}

function tagged(body: string, update: boolean): string {
  return `<system-reminder>\n${body}\n</system-reminder>${update ? "\n" : ""}`;
}

/** The reminders of a Claude route (`createReminders`): its model reminder names the model as the engine spells it,
 *  with the engine's wording of the extended window, in `claude` framing. */
export function createClaudeReminders(wireModelId: string, contextLimit: number, catalog?: ModelCatalogFacts): NonNullable<ServingAttempt["messagesToAppend"]> {
  const modelId = engineModelId(wireModelId, contextLimit);
  return createReminders({ modelId, contextWindow: contextLimit }, modelText(modelId, catalog, contextLimit), "claude");
}

/** The reminders of every route that is not a Claude route (`createReminders`): its model reminder names `modelId`,
 *  the model as the route's history target names it, its catalog name and knowledge cutoff when the catalog states
 *  them, and its context window, in `model` framing, so no request to another model reads it. */
export function createModelReminders(modelId: string, contextWindow: number, catalog?: ModelCatalogFacts): NonNullable<ServingAttempt["messagesToAppend"]> {
  return createReminders({ modelId, contextWindow }, modelText(modelId, catalog, contextWindow), "model");
}

/**
 * Returns the environment, model, and date reminders as ordinary hidden system-origin appends. History alone owns
 * prior announcements: the first request of a context gets the full set, and a later request after user input gets a
 * notice only when the working directory, git state, worktree state, model, or local date differs from the latest one
 * in history. Every route reads the environment and date reminders, whichever route wrote them; a route compares its
 * model, by model ID and context window, only with the latest model reminder of its own `framing`, so the reminders
 * of the other framing never change what it states. The worktree and download guidance renders for the capabilities
 * of the agent that the request serves (ARCH-CONTEXT-033). A request after a tool round, or one that continues
 * another route's partial answer, gets only a model notice and a date notice, each when the model or the local date
 * differs from the latest one in history: a person can change the model of a running turn, a turn can move to another
 * route, and the engine of the Agent SDK announces a new model and a new date at the next request. Input is never
 * changed.
 */
function createReminders(serving: { readonly modelId: string; readonly contextWindow: number }, model: string, framing: ModelFraming): NonNullable<ServingAttempt["messagesToAppend"]> {
  return (messages, executionCwd, capabilities) => {
    const lastInput = messages.findLast((message) => reminderIn(message) === undefined);
    const continuesPartial = lastInput?.kind === "assistant" && lastInput.incomplete === true;
    if (lastInput?.kind !== "user" && lastInput?.kind !== "toolResult" && !continuesPartial) return [];
    let previousCwd: string | undefined;
    let previousGit: boolean | undefined;
    let previousWorktree = false;
    let previousModel: Extract<RuntimeReminder, { kind: "model" }> | undefined;
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
      } else if (reminder?.kind === "model" && message.kind === "user" && message.framing === framing) previousModel = reminder;
      else if (reminder?.kind === "date") previousDate = reminder.date;
    }
    const date = localDate();
    const dateNotice = previousDate === date ? [] : [systemReminder(dateText(date, previousDate !== undefined), true, "reminder")];
    if (lastInput.kind !== "user" && previousDate === undefined) return [];
    const appends: SystemReminder[] = [];
    const append = (body: string, update: boolean, as: ModelFraming | "reminder" = "reminder") => appends.push(systemReminder(body, update, as));
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
    // A reminder in an earlier wording states no window, so it compares by model ID alone and an unchanged model is
    // not stated again.
    const stated = previousModel?.modelId === serving.modelId && (previousModel.contextWindow ?? serving.contextWindow) === serving.contextWindow;
    if (!stated) append(model, previousModel !== undefined, framing);
    return [...appends, ...dateNotice];
  };
}
