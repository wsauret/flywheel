export const GIT_MUTATION_REFUSAL = "Git repository writes are not allowed in a mutating command. Rerun this git command as a separate call without mutates.";

interface GitInvocation {
  readonly contextArgv: readonly string[];
  readonly commandArgv: readonly string[];
}

export type GitArgvPolicyResult = GitInvocation & (
  | { readonly kind: "read" }
  | { readonly kind: "refused"; readonly reason: "write-mode" | "unknown-command" | "global-option"; readonly exitCode: 97; readonly message: string }
);

type OptionArity = "flag" | "value" | "optional";
interface OptionSpec {
  readonly [option: string]: OptionArity;
}

interface InspectedOptions {
  readonly flags: Set<string>;
  readonly operands: string[];
}

const GLOBAL_VALUES = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
const GLOBAL_FLAGS = new Set([
  "--no-pager", "--paginate", "-p", "-P", "--bare", "--no-replace-objects",
  "--no-lazy-fetch", "--no-optional-locks", "--no-advice",
  "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs",
]);
const READ_COMMANDS = new Set([
  "status", "diff", "log", "show", "ls-files", "rev-parse", "blame", "grep", "describe",
  "rev-list", "cat-file", "show-ref", "for-each-ref", "ls-tree", "merge-base",
  "--version", "--help", "-v", "-h",
]);
const WRITE_COMMANDS = new Set([
  "add", "am", "apply", "archive", "bisect", "bundle", "checkout", "checkout-index", "cherry-pick",
  "clean", "clone", "commit", "commit-tree", "fetch", "fetch-pack", "filter-branch", "format-patch",
  "gc", "init", "maintenance", "merge", "merge-file", "merge-tree", "mv", "notes", "prune",
  "pull", "push", "read-tree", "rebase", "reflog", "remote-ext", "repack", "replace", "reset",
  "restore", "revert", "rm", "sparse-checkout", "stage", "submodule", "switch", "update-index",
  "update-ref", "write-tree",
]);

const BRANCH_OPTIONS = {
  "-d": "flag", "-D": "flag", "--delete": "flag", "-m": "flag", "-M": "flag", "--move": "flag",
  "-c": "flag", "-C": "flag", "--copy": "flag", "-f": "flag", "--force": "flag",
  "-t": "optional", "--track": "optional", "-u": "value", "--set-upstream-to": "value",
  "--set-upstream": "flag", "--unset-upstream": "flag", "--edit-description": "flag",
  "--create-reflog": "flag", "--recurse-submodules": "flag",
  "-l": "flag", "--list": "flag", "--no-list": "flag", "--show-current": "flag",
  "--no-show-current": "flag", "-a": "flag", "--all": "flag",
  "-r": "flag", "--remotes": "flag", "-v": "flag", "--verbose": "flag", "-q": "flag",
  "-i": "flag", "--ignore-case": "flag", "--quiet": "flag",
  "--contains": "optional", "--no-contains": "optional", "--merged": "optional",
  "--no-merged": "optional", "--points-at": "value", "--no-points-at": "flag",
  "--format": "value", "--sort": "value",
  "--color": "optional", "--column": "optional", "--abbrev": "optional",
} satisfies OptionSpec;
const BRANCH_WRITES = new Set([
  "-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy", "-f", "--force",
  "-t", "--track", "-u", "--set-upstream-to", "--set-upstream", "--unset-upstream",
  "--edit-description", "--create-reflog", "--recurse-submodules",
]);
const BRANCH_LISTS = new Set([
  "-l", "--list", "--show-current", "-a", "--all", "-r", "--remotes",
  "--contains", "--no-contains", "--merged", "--no-merged", "--points-at",
]);
const TAG_OPTIONS = {
  "-a": "flag", "--annotate": "flag", "-s": "flag", "--sign": "flag", "-u": "value",
  "--local-user": "value", "-m": "value", "--message": "value", "-F": "value", "--file": "value",
  "-e": "flag", "--edit": "flag", "-f": "flag", "--force": "flag", "-d": "flag", "--delete": "flag",
  "--create-reflog": "flag", "--trailer": "value", "--cleanup": "value",
  "-l": "flag", "--list": "flag", "-n": "optional", "--contains": "optional",
  "--no-contains": "optional", "--merged": "optional", "--no-merged": "optional",
  "--points-at": "value", "--no-points-at": "flag", "--format": "value", "--sort": "value",
  "--color": "optional", "--column": "optional", "-v": "flag", "--verify": "flag",
} satisfies OptionSpec;
const TAG_WRITES = new Set([
  "-a", "--annotate", "-s", "--sign", "-u", "--local-user", "-m", "--message", "-F", "--file",
  "-e", "--edit", "-f", "--force", "-d", "--delete", "--create-reflog", "--trailer", "--cleanup",
]);
const TAG_LISTS = new Set([
  "-l", "--list", "-n", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at",
]);
const CONFIG_OPTIONS = {
  "-f": "value", "--file": "value", "--blob": "value", "-t": "value", "--type": "value",
  "--default": "value", "--comment": "value", "--value": "value",
  "--get": "flag", "--get-all": "flag", "--get-regexp": "flag", "--get-urlmatch": "flag",
  "--get-color": "flag", "--get-colorbool": "flag", "-l": "flag", "--list": "flag",
  "--add": "flag", "--replace-all": "flag", "--unset": "flag", "--unset-all": "flag",
  "--rename-section": "flag", "--remove-section": "flag", "-e": "flag", "--edit": "flag",
} satisfies OptionSpec;
const CONFIG_WRITES = new Set([
  "--add", "--replace-all", "--unset", "--unset-all", "--rename-section", "--remove-section", "-e", "--edit",
]);
const CONFIG_READS = new Set([
  "--get", "--get-all", "--get-regexp", "--get-urlmatch", "--get-color", "--get-colorbool", "-l", "--list",
]);
const CONFIG_WRITE_COMMANDS = new Set(["set", "unset", "rename-section", "remove-section", "edit"]);

/** Parses only mode-bearing options and their values. Unknown arguments stay Git's responsibility.
 * Git's parse-options commands accept unique long-option abbreviations and short-option clusters. */
function inspectOptions(args: readonly string[], spec: OptionSpec, abbreviate = true): InspectedOptions {
  const flags = new Set<string>();
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    // SAFETY: The loop condition bounds this argv index.
    const arg = args[i]!;
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
      const matches = Object.keys(spec).filter((key) => key.startsWith("--") && key.startsWith(name));
      // SAFETY: A unique abbreviation has exactly one matching option.
      const key = spec[name] ? name : abbreviate && matches.length === 1 ? matches[0]! : name;
      if (key.startsWith("--no-") && spec[key] === "flag" && spec[`--${key.slice(5)}`]) {
        flags.delete(`--${key.slice(5)}`);
      } else {
        flags.add(key);
      }
      if (spec[key] === "value" && !arg.includes("=")) i++;
    } else if (arg.startsWith("-") && arg !== "-") {
      for (let j = 1; j < arg.length; j++) {
        const key = `-${arg[j]}`;
        flags.add(key === "-l" ? "--list" : key);
        if (spec[key] === "value" || spec[key] === "optional") {
          if (spec[key] === "value" && j === arg.length - 1) i++;
          break;
        }
      }
    } else {
      operands.push(arg);
    }
  }
  return { flags, operands };
}

function hasAny(flags: Set<string>, choices: ReadonlySet<string>): boolean {
  return [...flags].some((flag) => choices.has(flag));
}

function listsRefs(args: readonly string[], spec: OptionSpec, writes: ReadonlySet<string>, lists: ReadonlySet<string>): boolean {
  const { flags, operands } = inspectOptions(args, spec);
  return !hasAny(flags, writes) && (operands.length === 0 || hasAny(flags, lists));
}

function readsConfig(args: readonly string[]): boolean {
  const command = args[0];
  if (command && CONFIG_WRITE_COMMANDS.has(command)) return false;
  const explicitRead = command === "get" || command === "list";
  const { flags, operands } = inspectOptions(explicitRead ? args.slice(1) : args, CONFIG_OPTIONS);
  return !hasAny(flags, CONFIG_WRITES) && (explicitRead || hasAny(flags, CONFIG_READS) || operands.length <= 1);
}

function writesOutput(command: string, args: readonly string[]): boolean {
  if (!["diff", "log", "show", "stash", "rev-list", "blame"].includes(command)) return false;
  const stashShow = command === "stash" && args[0] === "show";
  const diffOnly = command === "diff" || stashShow;
  const { flags } = inspectOptions(args, {
    "--output": "value", "-S": "value", "-G": "value", "-O": "value", "-I": "value", "--ignore-matching-lines": "value",
    ...(!diffOnly ? { "-L": "value" as const } : {}),
    "--format": "optional", "--pretty": "optional",
    ...(!stashShow ? { "--grep": "value" as const, "--grep-reflog": "value" as const, "--author": "value" as const, "--committer": "value" as const } : {}),
    ...(command === "blame" ? {
      "--contents": "value" as const, "--ignore-rev": "value" as const, "--ignore-revs-file": "value" as const,
    } : {}),
  }, false);
  return flags.has("--output");
}

function readMode(command: string, args: readonly string[]): boolean | undefined {
  if (writesOutput(command, args)) return false;
  if (READ_COMMANDS.has(command)) return true;
  if (WRITE_COMMANDS.has(command)) return false;
  switch (command) {
    case "branch": return listsRefs(args, BRANCH_OPTIONS, BRANCH_WRITES, BRANCH_LISTS);
    case "tag": return listsRefs(args, TAG_OPTIONS, TAG_WRITES, TAG_LISTS);
    case "config": return readsConfig(args);
    case "symbolic-ref": {
      const { flags, operands } = inspectOptions(args, { "-m": "value", "-d": "flag", "--delete": "flag" });
      return !hasAny(flags, new Set(["-m", "-d", "--delete"])) && operands.length <= 1;
    }
    case "hash-object": {
      const { flags } = inspectOptions(args, { "-t": "value", "--path": "value", "-w": "flag" });
      return !flags.has("-w");
    }
    // This literal names Git's command, not Flywheel's protocol domain.
    case `remote`: {
      const { operands } = inspectOptions(args, {});
      return operands.length === 0 || operands[0] === "show" || operands[0] === "get-url";
    }
    case "stash": return args[0] === "list" || args[0] === "show";
    case "worktree": return args[0] === "list";
    default: return undefined;
  }
}

/** Classifies argv without the executable. No Git process or configuration lookup runs here.
 * Context argv preserves global options, including per-call configuration, in their original order.
 * A helper must insert trusted read overrides after contextArgv and before commandArgv.
 * For unknown-command only, the helper may resolve an ordinary alias in this context, then classify
 * the expanded argv recursively. It must preserve Git's built-in-command precedence over aliases.
 * Shell aliases are not admitted by this policy. Refusal messages contain no command text. */
export function classifyGitArgv(argv: readonly string[]): GitArgvPolicyResult {
  let index = 0;
  let invalidGlobal = false;
  while (index < argv.length) {
    // SAFETY: The loop condition bounds this argv index.
    const arg = argv[index]!;
    if (["--version", "--help", "-v", "-h"].includes(arg) || !arg.startsWith("-")) break;
    if (GLOBAL_FLAGS.has(arg)) {
      index++;
    } else if (GLOBAL_VALUES.has(arg)) {
      if (argv[index + 1] === undefined) {
        invalidGlobal = true;
        break;
      }
      index += 2;
    } else if ((arg.startsWith("-C") || arg.startsWith("-c")) && !arg.startsWith("--")) {
      index++;
    } else if (arg.includes("=") && GLOBAL_VALUES.has(arg.slice(0, arg.indexOf("=")))) {
      index++;
    } else {
      invalidGlobal = true;
      break;
    }
  }
  const contextArgv = argv.slice(0, index);
  const commandArgv = argv.slice(index);
  const command = commandArgv[0];
  const mode = command === undefined ? false : readMode(command, commandArgv.slice(1));
  if (!invalidGlobal && mode) return { kind: "read", contextArgv, commandArgv };
  return {
    kind: "refused", reason: invalidGlobal ? "global-option" : mode === undefined ? "unknown-command" : "write-mode",
    exitCode: 97, message: GIT_MUTATION_REFUSAL, contextArgv, commandArgv,
  };
}
