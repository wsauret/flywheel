import { sep } from "node:path";
import type { Node } from "web-tree-sitter";
import { extractShellCommand, outputRedirectTarget } from "./bash-command-parts.js";
import { loadBashParser } from "./bash-parser.js";
import { shellWriteEffects, type ShellOperand, type ShellWriteEffect } from "./bash-write-effects.js";
import { expandWriteArguments } from "./bash-write-argv.js";
import { joinShellFlow, shellFlow, shellSubstitutions, walkShellFlow, type ShellTransfers } from "./bash-write-flow.js";
import { registeredWorktreeRoots } from "./bash-write-roots.js";
import { ShellState } from "./bash-write-state.js";
import { expandShellFields, expandShellWord, isShellSink, placeShellPath, type ShellDialect } from "./bash-write-words.js";
import { unwrapShellCommand } from "./bash-write-wrappers.js";
import type { ShellEnvironment } from "./shell-environment.js";

/** Startup directory authorities plus the effective execution environment.
 * A read-only persona admits only scratch writes. Cwd never adds a root. */
export interface WriteScope {
  readonly projectRoot: string;
  readonly userDataRoot: string;
  readonly scratchDir?: string;
  readonly cwd: string;
  readonly env: Readonly<ShellEnvironment>;
  readonly dialect?: ShellDialect;
  readonly readOnly?: boolean;
}

/** What one analysis judges: where the command starts, and which placed,
 * physical target paths the caller's rule admits. */
export interface ShellWriteAdmission {
  readonly cwd: string;
  readonly env: Readonly<ShellEnvironment>;
  readonly dialect?: ShellDialect;
  readonly admits: (path: string) => boolean;
}

/** `refused`: a placed target that the rule does not admit. `ambiguousCwd`
 * is true when the command could run that write from more than one
 * directory. `unplaceable`: a target that analysis cannot place, whatever
 * the rule. */
export type WriteViolation =
  | { readonly kind: "refused"; readonly path: string; readonly raw: string; readonly effect: string; readonly ambiguousCwd: boolean }
  | { readonly kind: "unplaceable"; readonly raw: string; readonly effect: string };

/** The rule of a write scope: a target inside the project, the user data
 * root, or a registered worktree, or only inside scratch for a read-only
 * persona. Roots are placed once, on first use, the way targets are. */
export function scopeAdmission(scope: WriteScope): ShellWriteAdmission {
  const dialect = scope.dialect ?? "bash";
  let roots: string[] | undefined;
  const allowedRoots = (): readonly string[] => {
    roots ??= (scope.readOnly ? [scope.scratchDir] : [scope.projectRoot, scope.userDataRoot, ...registeredWorktreeRoots(scope.projectRoot)])
      .filter((path): path is string => path !== undefined)
      .map(path => placeShellPath({ value: path }, scope.cwd, dialect))
      .filter((path): path is string => path !== null);
    return roots;
  };
  return {
    cwd: scope.cwd,
    env: scope.env,
    dialect,
    admits: path => allowedRoots().some(rootPath => path === rootPath || path.startsWith(rootPath.endsWith(sep) ? rootPath : rootPath + sep)),
  };
}

class RefusedWrite extends Error {
  constructor(readonly violation: WriteViolation) { super("shell write refused"); }
}

const POWERSHELL_DIRECTORIES = new Map([
  ...["set-location", "sl", "cd", "chdir"].map(name => [name, "cd"] as const),
  ...["push-location", "pushd"].map(name => [name, "pushd"] as const),
  ...["pop-location", "popd"].map(name => [name, "popd"] as const),
]);

/** Analyze every statement before spawning. Analyzer failures, including its
 * work budget, propagate to the shared fail-open, coalesced warning boundary. */
export async function shellWriteViolation(root: Node, scope: ShellWriteAdmission): Promise<WriteViolation | null> {
  const dialect = scope.dialect ?? "bash";
  let remainingNodes = 100_000;
  const unplaceable = (effect: string, raw: string): never => { throw new RefusedWrite({ kind: "unplaceable", effect, raw }); };
  const refuse = (path: string, effect: string, raw: string, ambiguousCwd = false): never => { throw new RefusedWrite({ kind: "refused", path, effect, raw, ambiguousCwd }); };
  // An operand that no argv expansion produced expands from its value, not
  // its spelling: an effect can cut a prefix from the value, as `of=` from a
  // `dd` operand, and the spelling keeps that prefix for the message.
  const fields = (operand: ShellOperand | null, state: ShellState, literal = false) => {
    if (!operand) return null;
    if (operand.word !== undefined) return operand.word === null ? null : [operand.word];
    return literal ? [{ value: operand.value }] : expandShellFields(operand.value, name => state.lookup(name), dialect, state.changedIFS);
  };
  const check = (effect: ShellWriteEffect, state: ShellState, expansion = state): string[] => {
    const raw = effect.operand?.raw ?? "(dynamic target)";
    if (isShellSink(raw, dialect)) return [];
    const words = fields(effect.operand, expansion, effect.literal);
    if (!words) return unplaceable(effect.effect, raw);
    const paths: string[] = [];
    let refused: string | undefined;
    for (let cwd of state.workingDirectories) {
      for (const directory of effect.directories ?? []) {
        const expanded = fields(directory, expansion);
        cwd = expanded?.length === 1 && expanded[0] ? state.place(expanded[0], dialect, false, cwd) : null;
        if (cwd === null) return unplaceable(effect.effect, directory.raw);
      }
      for (const word of effect.directories?.length ? [{ value: "." }] : words) {
        if (isShellSink(word.value, dialect)) continue;
        // A network share is never placed physically; the rule judges its spelling.
        if (dialect === "powershell" && /^(?:\\\\|\/\/)/.test(word.value)) {
          if (!scope.admits(word.value)) return refuse(word.value, effect.effect, raw);
          continue;
        }
        const path = state.place(word, dialect, effect.deleteEntry, cwd);
        if (path === null) return unplaceable(effect.effect, raw);
        if (!scope.admits(path)) refused ??= path;
        paths.push(path);
      }
    }
    if (refused !== undefined) return refuse(refused, effect.effect, raw, state.workingDirectories.length > 1);
    return paths;
  };
  const payload = async (text: string | null, raw: string, state: ShellState, depth: number, exit = true): Promise<ShellState> => {
    if (depth >= 8) throw new Error("shell payload depth budget exhausted");
    if (text === null) return unplaceable("shell-payload", raw);
    const tree = (await loadBashParser()).parse(text);
    if (!tree) throw new Error("shell payload parse produced no tree");
    try {
      const result = joinShellFlow(await walkShellFlow(tree.rootNode, state, transfers, depth + 1));
      if (exit) await traps(result, depth + 1);
      return result;
    } finally { tree.delete(); }
  };
  const traps = async (state: ShellState, depth: number): Promise<void> => {
    for (const trap of state.pendingTraps()) await payload(trap.payload, trap.raw, (trap.signal === "EXIT" ? trap.current : trap.observed).copy(false), depth);
  };
  const transfers: ShellTransfers = {
    dialect,
    spend() { if (--remainingNodes < 0) throw new Error("shell analysis node budget exhausted"); },
    finish: traps,
    redirect(node, state) {
      const raw = outputRedirectTarget(node);
      if (raw !== undefined) check({ operand: raw === null ? null : { raw, value: raw }, effect: "redirect" }, state);
    },
    async command(node, children, state, depth) {
      const assignments = children.filter(child => child.type === "variable_assignment");
      for (const substitution of shellSubstitutions(node)) state.absorbFilesystem(joinShellFlow(await walkShellFlow(substitution, state.copy(), transfers, depth)));
      const commandState = assignments.length ? state.copy() : state;
      for (const assignment of assignments) commandState.assign(assignment.text, dialect);
      const extracted = node.type === "unset_command"
        ? { name: "unset", args: children.map(child => child.text), rawArgs: children.map(child => child.text), heredocBody: null }
        : extractShellCommand(node);
      const unwrapped = unwrapShellCommand(extracted, commandState, dialect, state);
      const { command, state: effective } = unwrapped;
      if (unwrapped.exhausted) return unplaceable("wrapper", extracted.name);
      if ("payload" in unwrapped) { state.absorbFilesystem(await payload(unwrapped.payload ?? null, extracted.rawArgs.join(" "), effective, depth)); return shellFlow(state); }
      if (["bash", "sh", "zsh", "dash", "ksh", "eval", "trap"].includes(command.name)) {
        const shell = !["eval", "trap"].includes(command.name);
        const flag = command.args.findIndex(arg => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
        let action = 0;
        if (command.name === "trap") {
          if (["-p", "-l"].includes(command.args[0] ?? "")) return shellFlow(state);
          if (command.args[0] === "--") action++;
          else if (command.args[0]?.startsWith("-") && command.args[0] !== "-") return unplaceable("trap", node.text);
        }
        const raw = shell ? command.rawArgs[flag + 1] : command.name === "trap" ? command.rawArgs[action] : command.rawArgs.join(" ");
        if (!shell || flag >= 0) {
          const text = raw === undefined || /[$`]/.test(raw.replace(/'[^']*'/g, "")) ? null : expandShellWord(raw, name => effective.lookup(name), dialect)?.value ?? null;
          if (command.name === "trap") {
            for (const signal of command.args.slice(action + 1)) state.registerTrap(`${node.id}:${signal}`, signal === "0" ? "EXIT" : signal.replace(/^SIG/, ""), text, raw ?? "trap");
          } else {
            const result = await payload(text, raw ?? command.name, shell ? effective.copy(false) : state, depth, shell);
            if (!shell) return shellFlow(result);
            state.absorbFilesystem(result);
          }
          return shellFlow(state);
        }
      }
      const directory = dialect === "powershell" ? POWERSHELL_DIRECTORIES.get(command.name.toLowerCase()) : ["cd", "pushd", "popd"].includes(command.name) ? command.name : undefined;
      if (directory) {
        const failure = state.copy();
        const mayFail = state.changeDirectory({ ...command, name: directory }, effective, dialect);
        return { success: state, failure: mayFail ? failure : state };
      }
      if (state.applyBuiltin(command)) return shellFlow(state);
      const expansion = state.copy(false);
      if (commandState.changedIFS) expansion.setVariable("IFS", null);
      const expanded = dialect === "bash" ? expandWriteArguments(command, expansion, dialect) : null;
      const effects = shellWriteEffects(expanded?.command ?? command, dialect, effective.env.TMPDIR ?? undefined, nested => {
        const inner = unwrapShellCommand(nested, effective, dialect);
        return !!inner.exhausted || "payload" in inner || shellWriteEffects(inner.command, dialect, inner.state.env.TMPDIR ?? undefined).length > 0;
      });
      if (effects.length && expanded?.indeterminate) return unplaceable(effects[0]?.effect ?? "write", command.rawArgs.join(" "));
      if (unwrapped.stdinTargets && shellWriteEffects({ ...command, args: [...command.args, "(stdin)"], rawArgs: [...command.rawArgs, "(stdin)"] }, dialect, effective.env.TMPDIR ?? undefined).length) return unplaceable(effects[0]?.effect ?? "write", "xargs (stdin)");
      const placed = effects.map(effect => ({ effect, paths: check(effect, effective, expansion) }));
      for (const { effect, paths } of placed) for (const path of paths) {
        const replacesEntries = ["ln", "mv", "cp", "install", "rsync", "tar", "unzip"].includes(command.name) && effect.effect !== "delete";
        if (replacesEntries || command.name === "mkdir") state.effect(path, command.name, replacesEntries, command.args.includes("-p") || command.args.includes("--parents"));
      }
      return shellFlow(state);
    },
  };
  try {
    const state = joinShellFlow(await walkShellFlow(root, ShellState.initial(scope.cwd, scope.env), transfers, 0));
    await traps(state, 0);
    return null;
  } catch (error) {
    if (error instanceof RefusedWrite) return error.violation;
    throw error;
  }
}
