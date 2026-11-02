import type { Tree } from "web-tree-sitter";
import type { ToolCall } from "../llm/types.js";
import { bashCommandNodes, loadBashParser } from "./bash-parser.js";
import { extractShellCommand, type ParsedCommand } from "./bash-command-parts.js";
import { scopeAdmission, shellWriteViolation, type WriteScope } from "./bash-write-targets.js";
import { DebugLog } from "../../../infra/debug-log.js";
import { WORKTREE_LIFECYCLE_SKILL_ID } from "../../../infra/directory-authorities.js";
import { Log } from "../../../infra/log.js";
import { coalesceRepeats } from "../../../infra/repeat-coalescer.js";
import { toolIdentity } from "../../tool-catalog.js";

interface NumberByUnit {
  [unit: string]: number;
}

const PLAIN_BUN_RUN_PACKAGE_SCRIPT = /^\s*bun\s+run\s+([A-Za-z0-9:_-]+)(?:\s+[A-Za-z0-9_./:@=,+%-]+)*\s*$/;


interface InteractiveRule {
  matches: (cmd: ParsedCommand) => boolean;
  fallbackPattern: RegExp;
  guidance: string;
}

const INTERACTIVE_RULES: readonly InteractiveRule[] = [
  {
    matches: (cmd) => new Set(["vim", "nvim", "nano", "emacs", "pico"]).has(cmd.name),
    fallbackPattern: /(?:^|[;&|(\n])\s*(?:vim|nvim|nano|emacs|pico)(?:\s|$|[;&|)])/,
    guidance: "editors can't run interactively - use the file edit tool for existing files, `write` for new files",
  },
  {
    matches: (cmd) => new Set(["less", "more", "most"]).has(cmd.name),
    fallbackPattern: /(?:^|[;&|(\n])\s*(?:less|more|most)(?:\s|$|[;&|)])/,
    guidance: "print the file with `cat` or `sed -n`, or use the read tool",
  },
  {
    matches: (cmd) => new Set(["top", "htop", "btop", "atop"]).has(cmd.name),
    fallbackPattern: /(?:^|[;&|(\n])\s*(?:top|htop|btop|atop)(?:\s|$|[;&|)])/,
    guidance: "use `ps aux` or `ps -eo ...` for a one-shot process snapshot",
  },
  {
    matches: (cmd) => cmd.name === "man" && cmd.args.length > 0,
    fallbackPattern: /(?:^|[;&|(\n])\s*man\s+\S+/,
    guidance: "use `--help` on the command or read the manpage source if needed",
  },
  {
    matches: (cmd) => new Set(["python", "python2", "python3", "ipython", "node", "ruby", "irb", "php", "lua"]).has(cmd.name)
      && !cmd.hasHeredocRedirect
      && (cmd.args.length === 0 || (cmd.args.length === 1 && cmd.args[0] === "-i")),
    fallbackPattern: /^\s*(?:python3?|ipython|node|ruby|irb|php|lua)(?:\s+-i)?\s*$/,
    guidance: "pass `-c 'code'` (or `-e`) to run inline, or write a script file and execute it",
  },
  {
    matches: (cmd) => cmd.name === "telnet" || cmd.name === "ftp",
    fallbackPattern: /(?:^|[;&|(\n])\s*(?:telnet|ftp)(?:\s|$|[;&|)])/,
    guidance: "use non-interactive alternatives: `curl`, `wget`, `ncat --exec`",
  },
  {
    matches: (cmd) => cmd.name === "nc" && cmd.args.includes("-l"),
    fallbackPattern: /(?:^|[;&|(\n])\s*nc\s+[^;&|\n]*-l(?:\s|$)/,
    guidance: "use non-interactive alternatives: `curl`, `wget`, `ncat --exec`",
  },
];

function interactiveBlock(command: string, guidance: string): BashInterception {
  return {
    message: `Interactive command detected (\`${command}\`) which would hang waiting for a TTY. ${guidance}.`,
  };
}

// Unconditionally blocked commands: no dedicated-tool substitute, the
// operation itself is disallowed. Other agents work in this tree
// concurrently, so commands that discard or hide worktree state they
// don't own (stash, hard reset, forced clean) can lose their work.
// Long sleeps are blocked too: a sleep is a permanent guess - too long
// wastes wall-clock after the awaited work finishes, too short burns a
// model turn just to sleep again - while background completion
// notifications wake the agent exactly when the work is done.
interface ForbiddenRule {
  matches: (cmd: ParsedCommand) => boolean;
  // Coarse fallback for the parser-unavailable path. May false-positive
  // (e.g. a commit message mentioning the command); acceptable on that
  // rare degraded path - policy beats letting the command through.
  fallbackPattern: RegExp;
  message: string;
}

// Skip git's global options (e.g. `git -C path stash`) to find the subcommand.
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

function gitSubcommandIndex(args: readonly string[]): number {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) return -1;
    if (!arg.startsWith("-")) return i;
    if (GIT_VALUE_OPTIONS.has(arg)) i++;
  }
  return -1;
}

function gitSubcommand(args: readonly string[]): string | null {
  return args[gitSubcommandIndex(args)] ?? null;
}

// The subcommands of `git stash` and `git worktree` that only report state.
// Every other one changes the stash list or the worktree set, and a bare
// `git stash` pushes. The text fallback cannot tell them apart and blocks all.
const READ_ONLY_GIT_ACTIONS = {
  stash: new Set(["list", "show"]),
  worktree: new Set(["list"]),
} as const;

/** `git <subcommand> <action>` where the action changes state: `git stash`, `git stash pop`, `git worktree add`. */
function isStateChangingGit(args: readonly string[], subcommand: keyof typeof READ_ONLY_GIT_ACTIONS): boolean {
  const index = gitSubcommandIndex(args);
  return args[index] === subcommand && !READ_ONLY_GIT_ACTIONS[subcommand].has(args[index + 1] ?? "");
}

function executableName(name: string): string {
  return name.replace(/\\/g, "/").split("/").at(-1) ?? name;
}

function unwrapExecutable(name: string, args: readonly string[]): { name: string; args: readonly string[] } | null {
  let currentName = executableName(name);
  const currentArgs = [...args];
  for (let depth = 0; depth < 8; depth++) {
    if (["command", "exec"].includes(currentName)) {
      while (currentArgs[0]?.startsWith("-")) currentArgs.shift();
    } else if (currentName === "env") {
      while (currentArgs[0]?.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(currentArgs[0] ?? "")) {
        const option = currentArgs.shift();
        if (["-u", "--unset", "-C", "--chdir", "-S", "--split-string"].includes(option ?? "")) currentArgs.shift();
      }
    } else if (currentName === "sudo") {
      while (currentArgs[0]?.startsWith("-")) {
        const option = currentArgs.shift();
        if (["-u", "-g", "-h", "-p", "-C", "-T", "-R", "-D"].includes(option ?? "")) currentArgs.shift();
      }
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(currentArgs[0] ?? "")) currentArgs.shift();
    } else {
      return { name: currentName, args: currentArgs };
    }
    const next = currentArgs.shift();
    if (!next) return null;
    currentName = executableName(next);
  }
  return null;
}

function isGitWorktreeCommand(cmd: ParsedCommand): boolean {
  const executable = unwrapExecutable(cmd.name, cmd.args);
  if (!executable) return GIT_WORKTREE_FALLBACK_PATTERN.test([cmd.name, ...cmd.rawArgs].join(" "));
  if (executable.name === "git") return isStateChangingGit(executable.args, "worktree");
  if (["sh", "bash", "zsh"].includes(executable.name)) {
    const c = executable.args.indexOf("-c");
    return c >= 0 && GIT_WORKTREE_FALLBACK_PATTERN.test(executable.args[c + 1] ?? "");
  }
  return false;
}

const WORKTREE_LIFECYCLE_BLOCK_MESSAGE = 'Command blocked: Git worktree operations other than `git worktree list` require the bundled lifecycle doctrine. Call `skill` with `action:"load"` and `skill_id:"worktree-lifecycle"`, then retry.';
const GIT_WORKTREE_FALLBACK_PATTERN = /\bgit\b[^;|&\n]*\bworktree\b/;

// A short-flag cluster containing the force flag: -f, -fd, -dfx, ...
/** `git push <remote> <object-id>:<ref>`: a push whose source is a raw commit
 *  id, not a branch. Only a commit built outside the checkout's branch needs
 *  one, and such a commit can carry stale copies of files over newer remote
 *  work. Git accepts an id abbreviated to four characters. A branch whose
 *  name is all hexadecimal reads the same, and pushes as `refs/heads/<name>`. */
function pushesObjectId(args: readonly string[]): boolean {
  const index = gitSubcommandIndex(args)
  if (args[index] !== "push") return false
  return args.slice(index + 1).filter((arg) => !arg.startsWith("-")).slice(1).some((refspec) => OBJECT_ID_REFSPEC.test(refspec))
}

const OBJECT_ID_REFSPEC = /^\+?[0-9a-f]{4,40}:/i

function hasForceFlag(args: readonly string[]): boolean {
  return args.some((a) => a === "--force" || /^-[A-Za-z]*f[A-Za-z]*$/.test(a));
}

const MAX_SLEEP_SECONDS = 30;

// GNU sleep accepts s/m/h/d suffixes and sums multiple arguments; macOS
// accepts plain (possibly fractional) seconds. Non-numeric args parse as 0.
const SLEEP_UNIT_SECONDS: NumberByUnit = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };

function sleepSeconds(args: readonly string[]): number {
  let total = 0;
  for (const arg of args) {
    const match = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(arg);
    if (!match) continue;
    const [, value = "0", unit = ""] = match;
    total += Number(value) * (SLEEP_UNIT_SECONDS[unit] ?? 1);
  }
  return total;
}

// These rules protect the shared working tree, so every shell tool answers to
// them, whatever its contract.
const TREE_SAFETY_RULES: readonly ForbiddenRule[] = [
  {
    matches: (c) => c.name === "git" && isStateChangingGit(c.args, "stash"),
    fallbackPattern: /\bgit\b[^;|&\n]*\bstash\b/,
    message:
      "Command blocked: `git stash` is disallowed; only `git stash list` and `git stash show` run. Other agents work in this tree concurrently and stashing hides their in-flight changes. Leave unrelated changes in place; if you need a clean checkpoint of your own work, commit it to a branch instead.",
  },
  {
    matches: (c) => c.name === "git" && gitSubcommand(c.args) === "reset" && c.args.includes("--hard"),
    fallbackPattern: /\bgit\b[^;|&\n]*\breset\b[^;|&\n]*--hard/,
    message:
      "Command blocked: `git reset --hard` is disallowed. Other agents work in this tree concurrently and a hard reset wipes their uncommitted changes along with yours. Revert your own files with a path-scoped `git restore <path>` instead.",
  },
  {
    matches: (c) => c.name === "git" && gitSubcommand(c.args) === "clean" && hasForceFlag(c.args),
    fallbackPattern: /\bgit\b[^;|&\n]*\bclean\b[^;|&\n]*(--force|\s-[A-Za-z]*f)/,
    message:
      "Command blocked: forced `git clean` is disallowed. Other agents work in this tree concurrently and cleaning deletes their untracked files. Delete only the specific files you created, by path.",
  },
  {
    matches: (c) => c.name === "git" && pushesObjectId(c.args),
    fallbackPattern: /\bgit\b[^;|&\n]*\bpush\b[^;|&\n]*\s\+?[0-9a-f]{4,40}:/i,
    message:
      "Command blocked: pushing a raw commit id is disallowed; push the checked-out branch. A commit built outside the branch can carry stale copies of files over newer remote work. When the remote is ahead and changed files you publish, apply your change in a worktree at the fetched remote tip, verify it there, and publish from that worktree. A branch whose name is all hexadecimal pushes as `refs/heads/<name>:<ref>`.",
  },
];

// The sleep rule steers the bash tool toward its own background contract.
const SLEEP_RULE: ForbiddenRule = {
  matches: (c) => c.name === "sleep" && sleepSeconds(c.args) > MAX_SLEEP_SECONDS,
  fallbackPattern: /\bsleep\s+(?:3[1-9](?!\d)|[4-9]\d(?!\d)|\d{3,}|\d+(?:\.\d+)?[mhd]\b)/,
  message:
    "Command blocked: sleeping longer than 30s is disallowed, foreground or backgrounded. A sleep guesses how long to wait; wait on the event instead. To wait for work to finish, run that command itself in the foreground: it blocks until it exits (bound slow ones with the timeout parameter, up to 3600s). To wait for a condition, loop on a check with short sleeps, such as `until <check>; do sleep 5; done`, bounded by the timeout parameter. To wait for a managed background command, subagent, or workflow, use `process` with `{ action: \"wait\" }` and a soft_timeout: its completion wakes you. Never use shell-level &, nohup, or disown.",
};

interface BashCommandInspection {
  readonly tree: Tree;
  readonly commands: readonly ParsedCommand[];
  close(): void;
}

const log = Log.create({ service: "bash-command-policy" });
const analysisFailures = coalesceRepeats<void>({
  windowMs: 60_000,
  first: (phase) => log.warn("bash command analysis unavailable; analysis-dependent checks skipped", { phase }),
  repeated: (phase, repeats) => log.warn("bash command analysis kept failing", { phase, repeats: repeats.count, windowMs: repeats.windowMs }),
});

/** Parses one command once and owns the tree until close. Callers must close the inspection.
 *  Awaits the shared parser load, so analysis never depends on warmup. Returns null when the
 *  parser cannot load, parsing yields no tree, or extraction throws; the failure is logged by
 *  phase only, never with command content. */
async function inspectBashCommand(command: string): Promise<BashCommandInspection | null> {
  let phase = "load";
  let tree: Tree | null = null;
  try {
    const parser = await loadBashParser();
    phase = "parse";
    tree = parser.parse(command);
    if (!tree) throw new Error("bash parse produced no tree");
    phase = "extract";
    const parsed = tree;
    const commands = bashCommandNodes(parsed.rootNode)
      .map((node) => extractShellCommand(node))
      .filter((extracted) => extracted.name.length > 0);
    return { tree: parsed, commands, close: () => parsed.delete() };
  } catch {
    tree?.delete();
    analysisFailures.observe(phase, undefined);
    return null;
  }
}

/** A refused command and the reason the agent reads. */
export interface BashInterception {
  readonly message: string;
}

export interface BashPolicyOptions {
  /** Runner-local skill identities whose bodies loaded successfully. */
  effectiveBundledSkillIds?: ReadonlySet<string>;
  /** Present at execution, after the tool resolves its per-call cwd. */
  scope?: WriteScope;
  /** Content-free correlation for the one refusal diagnostic. */
  ids?: { readonly sessionId?: string; readonly toolUseId?: string; readonly modelRequestId?: string };
}

// Without parsed commands (analysis unavailable), the text patterns decide.
function treeSafetyBlock(command: string, commands: readonly ParsedCommand[] | undefined, options: Pick<BashPolicyOptions, "effectiveBundledSkillIds"> | undefined): BashInterception | null {
  for (const rule of TREE_SAFETY_RULES) {
    if (commands ? commands.some((cmd) => rule.matches(cmd)) : rule.fallbackPattern.test(command)) return { message: rule.message };
  }
  const worktree = commands ? commands.some((cmd) => isGitWorktreeCommand(cmd)) : GIT_WORKTREE_FALLBACK_PATTERN.test(command);
  if (worktree && !options?.effectiveBundledSkillIds?.has(WORKTREE_LIFECYCLE_SKILL_ID)) return { message: WORKTREE_LIFECYCLE_BLOCK_MESSAGE };
  return null;
}

async function outsideWriteBlock(inspection: BashCommandInspection, options: BashPolicyOptions | undefined): Promise<BashInterception | null> {
  if (!options?.scope) return null;
  try {
    const violation = await shellWriteViolation(inspection.tree.rootNode, scopeAdmission(options.scope));
    if (!violation) return null;
    // A refused target that another working directory could also reach is as unknown as one that cannot be placed.
    const rule = violation.kind === "refused" && !violation.ambiguousCwd ? "outside" : "unplaceable";
    DebugLog.record({
      type: "agent.shell.write_refused",
      sessionId: options.ids?.sessionId,
      payload: { rule, effect: violation.effect, tool: "bash", toolUseId: options.ids?.toolUseId, modelRequestId: options.ids?.modelRequestId },
    });
    const persona = options.scope.readOnly ? " This agent is read-only." : "";
    return { message: rule === "unplaceable"
      ? `Command blocked because it is not a safe command.${persona} Flywheel cannot tell where this command writes (\`${violation.raw}\`). Write inside ${options.scope.readOnly ? "the scratchpad" : "the project or the scratchpad"}. Name the target as a literal path. Do not rephrase the command to reach the same target.`
      : `Command blocked because it is not a safe command.${persona} This command writes \`${violation.raw}\`, which is outside ${options.scope.readOnly ? "the scratchpad" : "the project, the .flywheel folders, and the project's registered worktrees"}. Write inside ${options.scope.readOnly ? "the scratchpad" : "the project or the scratchpad"} instead. Do not rephrase the command to reach the same target.` };
  } catch {
    analysisFailures.observe("targets", undefined);
    return null;
  }
}

/** Applies the bash command policy. Analysis fails open: when the command cannot be parsed, only the
 *  text-pattern forbidden, worktree, sleep, and interactive checks apply, for every agent role. */
export async function interceptBashCommand(command: string, options?: BashPolicyOptions): Promise<BashInterception | null> {
  const inspection = await inspectBashCommand(command);
  if (!inspection) {
    const unsafe = treeSafetyBlock(command, undefined, options);
    if (unsafe) return unsafe;
    if (SLEEP_RULE.fallbackPattern.test(command)) return { message: SLEEP_RULE.message };
    if (isPlainBunRunPackageScript(command)) return null;
    for (const rule of INTERACTIVE_RULES) {
      const hit = command.match(rule.fallbackPattern);
      if (hit) return interactiveBlock(hit[0], rule.guidance);
    }
    return null;
  }

  try {
    const commands = inspection.commands;
    const unsafe = treeSafetyBlock(command, commands, options);
    if (unsafe) return unsafe;
    if (commands.some((cmd) => SLEEP_RULE.matches(cmd))) return { message: SLEEP_RULE.message };
    for (const cmd of commands) {
      for (const rule of INTERACTIVE_RULES) {
        if (rule.matches(cmd)) return interactiveBlock([cmd.name, ...cmd.rawArgs].join(" "), rule.guidance);
      }
    }
    return await outsideWriteBlock(inspection, options);
  } finally {
    inspection.close();
  }
}

/** The physical path of the first target of `command`, run from `cwd`, that
 *  `admits` refuses, or null. The kernel write analyzer places every target,
 *  so a module rule that protects paths supplies only its admission. Null also
 *  covers a target that cannot be placed, which the shell's own write rule
 *  refuses with its own message, and analysis that cannot load or complete:
 *  the rule fails open (ARCH-TOOLS-010), and that failure records once through
 *  the shared coalescer. Never throws. */
export async function refusedShellWrite(command: string, cwd: string, admits: (path: string) => boolean): Promise<string | null> {
  const inspection = await inspectBashCommand(command);
  if (!inspection) return null;
  try {
    const violation = await shellWriteViolation(inspection.tree.rootNode, { cwd, env: process.env, dialect: process.platform === "win32" ? "powershell" : "bash", admits });
    return violation?.kind === "refused" ? violation.path : null;
  } catch {
    analysisFailures.observe("targets", undefined);
    return null;
  } finally {
    inspection.close();
  }
}

function isPlainBunRunPackageScript(command: string): boolean {
  const match = command.match(PLAIN_BUN_RUN_PACKAGE_SCRIPT);
  return match !== null && match[1] !== undefined;
}

// A yield-placeholder is a bash call whose only purpose is to park the turn
// (a tool call is the opposite of yielding). It executes like any other
// command - every provider transcript must carry a result for every call, so
// nothing is erased - but a turn whose calls were all wait-shaped parks on
// background work afterwards instead of re-requesting (agent-loop.ts).
// Classification only counts while background work is pending: the completing
// task re-drives the loop, so the park always wakes. With nothing in flight
// there is nothing to wake the loop, so every shape below is an ordinary
// command with no park semantics.
//
// With background work pending, two shapes qualify:
//
//   1. Every statement is a bare no-op (`true`, `:`) or a bare `sleep N`,
//      optionally with a trailing comment. Zero semantic content beyond
//      timing, and with background work pending the timing is pointless.
//      No wait-intent text required.
//   2. The LEADING statement is a no-op (echo/printf, sleep, `true`, `:`)
//      AND the text expresses wait/yield intent. This agent narrates in
//      prose, never via echo, so a command that opens with a no-op while it
//      is waiting on background work is a yield signal even if junk trails
//      it (`echo waiting; yielding`). Over-classifying is bounded: the
//      completing task re-drives the loop.
//
// The wait-intent requirement on shape 2 keeps harmless `echo hello` from
// parking the turn.
const BARE_NOOP_PATTERN = /^(true|:)\s*(#.*)?$/;
const BARE_SLEEP_PATTERN = /^sleep\s+\d+(\.\d+)?[smhd]?\s*(#.*)?$/;
const NOOP_COMMAND_PATTERN = /^(echo|printf|sleep|true|:)(\s|$)/;
const WAIT_INTENT_PATTERN = /\b(wait|yield|standby|stand by|standing by|idle|holding|pending|in progress|still (?:run|work|process))/i;

function isYieldPlaceholderCommand(command: string, hasPendingBackgroundWork: boolean): boolean {
  if (!hasPendingBackgroundWork) return false;
  const segments = command
    .split(/(?:&&|\|\||[;&|\n])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const [first] = segments;
  if (!first) return false;
  if (segments.every((seg) => BARE_SLEEP_PATTERN.test(seg) || BARE_NOOP_PATTERN.test(seg))) return true;
  if (!WAIT_INTENT_PATTERN.test(command)) return false;
  return NOOP_COMMAND_PATTERN.test(first);
}

export function isYieldPlaceholderToolCall(toolCall: ToolCall, hasPendingBackgroundWork: boolean): boolean {
  if (toolIdentity(toolCall.name) !== "bash") return false;
  const command = toolCall.input.command;
  return typeof command === "string" && isYieldPlaceholderCommand(command, hasPendingBackgroundWork);
}
