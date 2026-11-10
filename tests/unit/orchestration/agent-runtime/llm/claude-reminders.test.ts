import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localDate } from "../../../../../src/infra/env-detection.js";
import { createClaudeReminders, parseClaudeReminder } from "../../../../../src/orchestration/agent-runtime/llm/claude-reminders.js";
import type { CapabilityCheck } from "../../../../../src/infra/capability-text.js";
import { promptCapabilities, SHELL_CAPABILITIES } from "../../../../helpers/prompt-capabilities.js";
import type { ConversationMessage } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { redactMessage } from "../../../../../src/orchestration/agent-runtime/agent-loop-history.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

/** The reminders of `model` for an agent with the capabilities that each call names, the shell by default. */
function shellReminders(model: string, contextLimit: number) {
  const reminders = createClaudeReminders(model, contextLimit);
  return (messages: readonly ConversationMessage[], cwd: string, has: CapabilityCheck = SHELL_CAPABILITIES) => reminders(messages, cwd, has);
}
const NO_SHELL = promptCapabilities([{ name: "read" }]);

afterEach(() => {
  setSystemTime();
});

function parsed(message: ConversationMessage | undefined, previousWorkingDirectory?: string) {
  if (message?.kind !== "user" || typeof message.content !== "string") throw new Error("A reminder is a user entry with text content");
  return parseClaudeReminder(message.content, previousWorkingDirectory);
}

test("reminders are ordinary history and a model change reaches the next request, after a tool round or user input", () => {
  const haiku = shellReminders("claude-haiku-4-5", 200_000);
  const history: ConversationMessage[] = [{ kind: "user", origin: "human", content: "Keep my words." }];
  const initial = haiku(history, "/scratch");
  expect(initial).toHaveLength(3);
  expect(initial.every((message) => message.kind === "user" && message.origin === "system")).toBe(true);
  expect(parsed(initial[0])).toMatchObject({ kind: "environment", workingDirectory: "/scratch", isGitRepo: false, isWorktree: false });
  expect(initial[1]?.content).toBe("<system-reminder>\nThe model that answers is Haiku 4.5, with the model ID claude-haiku-4-5. Its training data ends in February 2025.\n</system-reminder>");
  expect(parsed(initial[2])).toEqual({ kind: "date", date: localDate(), changed: false });
  expect(initial[2]?.content).toEndWith("</system-reminder>\n");
  // The shell and download handling are for an agent that can call the shell: one without it reads the other facts only.
  expect(initial[0]?.content).toContain("Treat every file that you download");
  expect(initial[0]?.content).toContain(" - Shell: ");
  const noShell = haiku(history, "/scratch", NO_SHELL);
  expect(noShell[0]?.content).not.toContain("Treat every file that you download");
  expect(noShell[0]?.content).not.toContain(" - Shell: ");
  const facts = parsed(initial[0]);
  if (facts?.kind !== "environment") throw new Error("The opening reminder states the environment");
  const { shell: _shell, ...withoutShell } = facts;
  expect(parsed(noShell[0])).toStrictEqual(withoutShell);
  // The history of an agent without the shell holds its announcement, so the next request states it again only on a change.
  expect(haiku([...history, ...noShell], "/scratch", NO_SHELL)).toEqual([]);
  // The label names who wrote each reminder, so a route never reads a person's text with the same bytes as one.
  expect(initial.map((message) => message.kind === "user" ? message.framing : undefined)).toEqual(["reminder", "claude", "reminder"]);
  expect(history).toEqual([{ kind: "user", origin: "human", content: "Keep my words." }]);
  history.push(...structuredClone(initial));
  expect(haiku(history, "/scratch")).toEqual([]);
  history.push({ kind: "assistant", content: [{ type: "tool_use", id: "call", name: "read", input: {} }] }, { kind: "toolResult", toolUseId: "call", content: [{ type: "text", text: "Read." }] });
  const sonnet = shellReminders("claude-sonnet-4-6", 200_000);
  const update = [{ kind: "user", origin: "system", content: "<system-reminder>\nThe model that answers is Sonnet 4.6, with the model ID claude-sonnet-4-6. Its training data ends in August 2025.\n</system-reminder>\n", framing: "claude" }] satisfies ConversationMessage[];
  expect(sonnet(history, "/scratch")).toEqual(update);
  history.push({ kind: "assistant", content: "Done." }, { kind: "user", origin: "human", content: "Next." });
  expect(sonnet(history, "/scratch")).toEqual(update);
  const resumed = structuredClone([...history, ...update]);
  expect(sonnet(resumed, "/scratch")).toEqual([]);
  expect(sonnet([{ kind: "user", origin: "system", content: "Recover from notes." }], "/scratch")).toHaveLength(3);
  expect(haiku([{ kind: "user", origin: "human", content: initial.map(({ content }) => content).join("\n") }], "/scratch")).toHaveLength(3);
  const moved = sonnet(resumed, "/other<&\n");
  expect(moved).toHaveLength(1);
  expect(parsed(moved[0])).toEqual({ kind: "environment-update", workingDirectory: "/other<&\n" });
  expect(moved[0]?.content).toContain("/other&lt;&&#10;");
  expect(moved[0]?.content).toContain("/scratch");
  expect(sonnet([...resumed, ...moved], "/other<&\n")).toEqual([]);
  // A raw value that already looks escaped must not read back as a different directory.
  for (const literal of ["/scratch/&lt;raw&gt;", "/scratch/&#10;raw"]) {
    const announced = sonnet([{ kind: "user", origin: "human", content: "Start." }], literal);
    expect(sonnet([{ kind: "user", origin: "human", content: "Start." }, ...announced], literal)).toEqual([]);
  }
  const credentialDirectoryName = `Bearer ${"x".repeat(24)}`;
  for (const name of ["project (was old)", credentialDirectoryName]) {
    const cwd = join(temporaryDirectory("claude-reminder-replay-"), name);
    mkdirSync(cwd);
    const seed: ConversationMessage[] = [{ kind: "user", origin: "human", content: "Continue." }];
    const announced = sonnet(seed, cwd).map((message) => redactMessage(message, false));
    expect(JSON.stringify(announced)).not.toContain(credentialDirectoryName);
    expect(sonnet([...seed, ...announced], cwd)).toEqual([]);
    const nextCwd = `${cwd} next (was elsewhere)`;
    mkdirSync(nextCwd);
    const changed = sonnet([...seed, ...announced], nextCwd).map((message) => redactMessage(message, false));
    expect(changed).toHaveLength(1);
    expect(sonnet([...seed, ...announced, ...changed], nextCwd)).toEqual([]);
  }
  const dated = resumed.map((message): ConversationMessage => message.kind === "user" && typeof message.content === "string" && parseClaudeReminder(message.content)?.kind === "date"
    ? { ...message, content: message.content.replace(localDate(), "2000-01-01") }
    : message);
  const dateUpdate = sonnet(dated, "/scratch");
  expect(dateUpdate).toHaveLength(1);
  expect(parsed(dateUpdate[0])).toEqual({ kind: "date", date: localDate(), changed: true });
  expect(sonnet([...dated, ...dateUpdate], "/scratch")).toEqual([]);
  const extendedInitial = shellReminders("claude-opus-4-6", 1_000_000)([{ kind: "user", origin: "human", content: "Hi." }], "/scratch");
  expect(extendedInitial[1]?.content).toBe("<system-reminder>\nThe model that answers is Opus 4.6 (1M context), with the model ID claude-opus-4-6[1m]. Its training data ends in May 2025.\n</system-reminder>");
  const unknown = shellReminders("claude-unknown-8", 200_000);
  expect(unknown([{ kind: "user", origin: "human", content: "Hi." }], "/scratch")[1]?.content).toBe("<system-reminder>\nThe model that answers has the model ID claude-unknown-8.\n</system-reminder>");
  const linked = temporaryDirectory("claude-reminder-worktree-");
  const gitDirectory = join(linked, "metadata");
  const nested = join(linked, "nested");
  mkdirSync(gitDirectory);
  mkdirSync(nested);
  writeFileSync(join(linked, ".git"), "gitdir: metadata\n");
  writeFileSync(join(gitDirectory, "commondir"), "../main\n");
  const worktree = sonnet(resumed, nested);
  expect(parsed(worktree[0], "/scratch")).toEqual({ kind: "environment-update", workingDirectory: nested, isWorktree: true, isGitRepo: true });
  // Entering a worktree also states how to work in one: stay in it, and do not pop the stash list that every checkout shares.
  expect(worktree[0]?.content).toContain("git stash apply <hash>");
  const unshelled = sonnet(resumed, nested, NO_SHELL);
  expect(unshelled[0]?.content).toContain("The working directory is a linked worktree");
  expect(unshelled[0]?.content).not.toContain("git stash");
  expect(parsed(unshelled[0], "/scratch")).toEqual(parsed(worktree[0], "/scratch"));
  expect(sonnet([...resumed, ...worktree], nested)).toEqual([]);
  const exited = sonnet([...resumed, ...worktree], "/scratch");
  expect(parsed(exited[0], nested)).toEqual({ kind: "environment-update", workingDirectory: "/scratch", isWorktree: false, isGitRepo: false });
  expect(exited[0]?.content).not.toContain("git stash");
});

test("a new local date and a new model reach the next request, a tool round included, while an environment change waits for user input", () => {
  // A day apart, so the two instants name different local dates in every zone.
  const tomorrow = new Date("2026-10-10T12:00:00Z");
  setSystemTime(new Date("2026-10-09T12:00:00Z"));
  const haiku = shellReminders("claude-haiku-4-5", 200_000);
  const history: ConversationMessage[] = [{ kind: "user", origin: "human", content: "Read the note." }];
  history.push(...haiku(history, "/scratch"), { kind: "assistant", content: [{ type: "tool_use", id: "call", name: "read", input: {} }] }, { kind: "toolResult", toolUseId: "call", content: [{ type: "text", text: "Read." }] });
  expect(haiku(history, "/scratch")).toEqual([]);

  setSystemTime(tomorrow);
  const sonnet = shellReminders("claude-sonnet-4-6", 200_000);
  const toolRound = sonnet(history, "/other");
  expect(toolRound[0]).toEqual({ kind: "user", origin: "system", content: "<system-reminder>\nThe model that answers is Sonnet 4.6, with the model ID claude-sonnet-4-6. Its training data ends in August 2025.\n</system-reminder>\n", framing: "claude" });
  expect(toolRound.map((message) => parsed(message))).toEqual([expect.objectContaining({ kind: "model" }), { kind: "date", date: localDate(tomorrow), changed: true }]);
  history.push(...toolRound);
  expect(sonnet(history, "/other")).toEqual([]);

  history.push({ kind: "assistant", content: "Done." }, { kind: "user", origin: "human", content: "Next." });
  expect(sonnet(history, "/other").map((message) => parsed(message, "/scratch")?.kind)).toEqual(["environment-update"]);
});

test("parsing reads back the facts of every reminder the producer writes", () => {
  setSystemTime(new Date(2026, 9, 7, 12));
  const cwd = "/scratch/a<b>&\n";
  const [environment, model, date] = shellReminders("claude-opus-4-6", 1_000_000)([{ kind: "user", origin: "human", content: "Hi." }], cwd)
    .map((message) => parsed(message));
  expect(environment).toMatchObject({ kind: "environment", workingDirectory: cwd, isWorktree: false, isGitRepo: false, platform: process.platform });
  expect(model).toEqual({
    kind: "model", modelId: "claude-opus-4-6[1m]", displayName: "Opus 4.6 (1M context)", knowledgeCutoff: "May 2025",
    text: "The model that answers is Opus 4.6 (1M context), with the model ID claude-opus-4-6[1m]. Its training data ends in May 2025.",
  });
  expect(date).toEqual({ kind: "date", date: "2026-10-07", changed: false });
  const unknown = shellReminders("claude-unknown-8", 200_000)([{ kind: "user", origin: "human", content: "Hi." }], cwd)[1];
  expect(parsed(unknown)).toEqual({ kind: "model", modelId: "claude-unknown-8", text: "The model that answers has the model ID claude-unknown-8." });
});

test("a model the display table does not know is named by its own catalog facts, and a table entry wins over them", () => {
  const hi: ConversationMessage[] = [{ kind: "user", origin: "human", content: "Hi." }];
  const modelOf = (reminders: ReturnType<typeof createClaudeReminders>) => parsed(reminders(hi, "/scratch", SHELL_CAPABILITIES)[1]);
  expect(modelOf(createClaudeReminders("claude-fable-5-3", 1_000_000, { name: "Claude Fable 5.3", knowledgeCutoff: "2026-06" }))).toEqual({
    kind: "model", modelId: "claude-fable-5-3[1m]", displayName: "Fable 5.3", knowledgeCutoff: "June 2026",
    text: "The model that answers is Fable 5.3, with the model ID claude-fable-5-3[1m]. Its training data ends in June 2026.",
  });
  expect(modelOf(createClaudeReminders("claude-fable-5-3", 200_000, { name: "Claude Fable 5.3", knowledgeCutoff: "2026-06-30" })))
    .toMatchObject({ text: "The model that answers is Fable 5.3, with the model ID claude-fable-5-3. Its training data ends in June 2026." });
  expect(modelOf(createClaudeReminders("claude-opus-4-6", 1_000_000, { name: "Claude 4.6 Opus", knowledgeCutoff: "2025-08" })))
    .toMatchObject({ text: "The model that answers is Opus 4.6 (1M context), with the model ID claude-opus-4-6[1m]. Its training data ends in May 2025." });
  expect(modelOf(createClaudeReminders("claude-fable-5-3", 200_000)))
    .toMatchObject({ text: "The model that answers has the model ID claude-fable-5-3." });
});

test("parsing reads every kind of change notice", () => {
  const reminders = shellReminders("claude-sonnet-4-6", 200_000);
  const linked = temporaryDirectory("claude-reminder-parse-");
  const before = join(linked, "project (was old)");
  const nested = join(linked, "project (was old) next");
  mkdirSync(join(linked, "metadata"));
  mkdirSync(before);
  mkdirSync(nested);
  writeFileSync(join(linked, ".git"), "gitdir: metadata\n");
  writeFileSync(join(linked, "metadata", "commondir"), "../main\n");
  const outside = [{ kind: "user", origin: "human", content: "Start." }, ...reminders([{ kind: "user", origin: "human", content: "Start." }], "/scratch/outside")] satisfies ConversationMessage[];
  const [entered] = reminders([...outside, { kind: "assistant", content: "Ok." }, { kind: "user", origin: "human", content: "Move." }], before);
  expect(parsed(entered, "/scratch/outside")).toEqual({ kind: "environment-update", workingDirectory: before, isWorktree: true, isGitRepo: true });
  const inside = [...outside, entered!];
  const [moved] = reminders([...inside, { kind: "user", origin: "human", content: "Again." }], nested);
  expect(parsed(moved, before)).toEqual({ kind: "environment-update", workingDirectory: nested });
  expect(parsed(moved)).toEqual({ kind: "environment-update", workingDirectory: nested });
  const [exited] = reminders([...inside, { kind: "user", origin: "human", content: "Leave." }], "/scratch/outside");
  expect(parsed(exited, before)).toEqual({ kind: "environment-update", workingDirectory: "/scratch/outside", isWorktree: false, isGitRepo: false });
  for (const other of ["Today's date is 2026-10-07.", "<system-reminder>\nRemember the plan.\n</system-reminder>", "<system-reminder>\n# Runtime environment\nWorking directory: /scratch\n</system-reminder>"]) {
    expect(parseClaudeReminder(other)).toBeUndefined();
  }
});

test("reminders that builds before 2026-10-27 wrote still read as their facts, so a resumed conversation states only what changed", () => {
  // The fixtures keep each earlier line's labels and structure; the parser does not read the earlier prose lines.
  const tagged = (lines: readonly string[], update: boolean) => `<system-reminder>\n${lines.join("\n")}\n</system-reminder>${update ? "\n" : ""}`;
  const legacyEnvironment = (cwd: string) => tagged(["# Environment", "Earlier introduction.", ` - Primary working directory: ${cwd}`, " - Is a git repository: true",
    " - Platform: darwin", " - Shell: zsh", " - OS Version: Darwin 25.3.0", " - Earlier guidance."], false);
  expect(parseClaudeReminder(legacyEnvironment("/scratch&lt;old"))).toEqual({
    kind: "environment", workingDirectory: "/scratch<old", isWorktree: false, isGitRepo: true, platform: "darwin", shell: "zsh", osVersion: "Darwin 25.3.0",
  });
  const enteredWorktree = tagged(["# Environment update", " - Primary working directory: /scratch/wt (was /scratch)", " - This is a git worktree, earlier guidance.", " - Earlier stash guidance.", " - Is a git repository: true (was false)"], true);
  expect(parseClaudeReminder(enteredWorktree, "/scratch")).toEqual({ kind: "environment-update", workingDirectory: "/scratch/wt", isWorktree: true, isGitRepo: true });
  expect(parseClaudeReminder(enteredWorktree)).toEqual({ kind: "environment-update", workingDirectory: "/scratch/wt (was /scratch)", isWorktree: true, isGitRepo: true });
  expect(parseClaudeReminder(tagged(["# Environment update", " - Earlier text: no longer a git worktree."], true))).toEqual({ kind: "environment-update", isWorktree: false });
  expect(parseClaudeReminder(tagged(["Today's date is 2026-10-07."], true))).toEqual({ kind: "date", date: "2026-10-07", changed: false });
  const legacyModel = tagged(["You are powered by the model named Sonnet 4.6. The exact model ID is claude-sonnet-4-6. Assistant knowledge cutoff is August 2025."], false);
  expect(parseClaudeReminder(legacyModel)).toMatchObject({ kind: "model", modelId: "claude-sonnet-4-6", displayName: "Sonnet 4.6", knowledgeCutoff: "August 2025" });
  expect(parseClaudeReminder(tagged(["You are powered by the model claude-unknown-8."], false))).toMatchObject({ kind: "model", modelId: "claude-unknown-8" });
  expect(parseClaudeReminder(tagged(["Earlier sentence. Today's date is now 2026-10-08. Earlier closing sentence."], true))).toEqual({ kind: "date", date: "2026-10-08", changed: true });

  setSystemTime(new Date(2026, 9, 8, 12));
  const cwd = temporaryDirectory("claude-reminder-legacy-");
  const reminders = shellReminders("claude-sonnet-4-6", 200_000);
  const start: ConversationMessage = { kind: "user", origin: "human", content: "Start." };
  const legacyHistory: ConversationMessage[] = [
    start,
    { kind: "user", origin: "system", content: legacyEnvironment(cwd).replace("Is a git repository: true", "Is a git repository: false") },
    { kind: "user", origin: "system", content: legacyModel },
    { kind: "user", origin: "system", content: tagged([`Today's date is ${localDate()}.`], true) },
    { kind: "assistant", content: "Ok." }, { kind: "user", origin: "human", content: "Next." },
  ];
  expect(reminders(legacyHistory, cwd)).toEqual([]);
  const moved = reminders(legacyHistory, join(cwd, ".."));
  expect(moved.map((message) => parsed(message, cwd))).toEqual([{ kind: "environment-update", workingDirectory: join(cwd, "..") }]);
});
