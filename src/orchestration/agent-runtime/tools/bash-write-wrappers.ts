import { shellExecutable, type ShellWriteCommand } from "./bash-write-effects.js";
import { expandShellWord, placeShellPath, type ShellDialect } from "./bash-write-words.js";
import type { ShellState } from "./bash-write-state.js";

const WRAPPER_VALUES = new Map<string, readonly string[]>([
  ["sudo", ["-u", "-g", "-h", "-p", "-C", "-T", "-R", "-D", "--user", "--group", "--host", "--prompt", "--chdir", "--chroot"]],
  ["doas", ["-u", "-C"]],
  ["command", []], ["builtin", []], ["exec", ["-a"]],
  ["nice", ["-n", "--adjustment"]], ["nohup", []],
  ["time", ["-f", "-o", "--format", "--output"]],
  ["timeout", ["-k", "-s", "--kill-after", "--signal"]],
  ["stdbuf", ["-i", "-o", "-e", "--input", "--output", "--error"]],
  ["ionice", ["-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid"]],
  ["chrt", ["-T", "-P", "-D"]], ["setsid", []], ["busybox", []],
  ["xargs", ["-I", "-L", "-n", "-s", "-P", "-E", "-d", "--replace", "--max-lines", "--max-args", "--max-chars", "--max-procs", "--eof", "--delimiter"]],
]);

const WRAPPER_FLAGS = new Map<string, readonly string[]>([
  ["sudo", ["-n", "-E", "-H", "-S", "-k", "-K", "-b", "--non-interactive", "--preserve-env"]],
  ["doas", ["-n", "-s", "-L"]], ["command", ["-p", "-v", "-V"]], ["builtin", []],
  ["exec", ["-c", "-l"]], ["nice", []], ["nohup", []], ["time", ["-p", "-a", "-v"]],
  ["timeout", ["--foreground", "--preserve-status", "-v"]], ["stdbuf", []],
  ["ionice", ["-t"]], ["chrt", ["-i", "-r", "-f", "-b", "-o", "-a", "-R", "-v"]],
  ["setsid", ["-c", "-f", "-w"]], ["busybox", []], ["xargs", ["-0", "-r", "-t", "-p", "-x", "--null", "--no-run-if-empty"]],
]);

/** env -S has its own grammar, not shell syntax. Unsupported escapes or
 * expansions stay unknown. Render decoded argv as literal shell words. */
function envSplitPayload(text: string, state: ShellState): string | null {
  const words: string[] = [];
  let word = "";
  let quote = "";
  let present = false;
  const finish = (): void => { if (present) words.push(word); word = ""; present = false; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? "";
    if (char === "\\" && quote !== "'") {
      const next = text[++i];
      if (next === "c" && !quote) break;
      if (next === "_") { if (quote) word += " "; else finish(); }
      else if (next && "\\'\"#$".includes(next)) { word += next; present = true; }
      else return null;
    } else if ((char === "'" || char === '"') && (!quote || quote === char)) {
      quote = quote ? "" : char; present = true;
    } else if (char === "$" && quote !== "'") {
      const match = /^\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(text.slice(i + 1));
      if (!match?.[1]) return null;
      const value = state.lookup(match[1]);
      if (value === null) return null;
      word += value ?? ""; present = true; i += match[0].length;
    } else if (!quote && /[ \t\n]/.test(char)) finish();
    else if (!quote && char === "#" && !present) break;
    else { word += char; present = true; }
  }
  if (quote) return null;
  finish();
  return words.map(value => `'${value.replaceAll("'", "'\\''")}'`).join(" ");
}

export interface UnwrappedShellCommand {
  readonly command: ShellWriteCommand;
  readonly state: ShellState;
  readonly stdinTargets: boolean;
  readonly payload?: string | null;
  readonly exhausted?: boolean;
}

/** Remove supported wrappers option by option, retaining local environment
 * and cwd changes. Payloads and stdin-fed operands remain explicit effects. */
export function unwrapShellCommand(command: ShellWriteCommand, initial: ShellState, dialect: ShellDialect, expansion = initial): UnwrappedShellCommand {
  const state = initial.copy();
  const literal = (raw: string): string => expandShellWord(raw, () => undefined, dialect)?.value ?? raw;
  let name = shellExecutable(literal(command.name));
  const args = [...command.rawArgs];
  let stdinTargets = false;
  for (let depth = 0; depth < 16; depth++) {
    if (name === "env") {
      while (args.length > 0) {
        const arg = literal(args[0] ?? "");
        if (arg === "--") { args.shift(); break; }
        if (arg === "-i" || arg === "--ignore-environment" || arg === "-") { state.clearEnvironment(); args.shift(); }
        else if (arg === "-u" || arg === "--unset") { args.shift(); state.setVariable(literal(args.shift() ?? ""), undefined); }
        else if (arg.startsWith("-u") && !arg.startsWith("--")) { state.setVariable(arg.slice(2), undefined); args.shift(); }
        else if (arg.startsWith("--unset=")) { state.setVariable(arg.slice(8), undefined); args.shift(); }
        else if (arg === "-C" || arg.startsWith("-C") || arg === "--chdir" || arg.startsWith("--chdir=")) {
          args.shift();
          const raw = arg.startsWith("--chdir=") ? arg.slice(8) : arg.length > 2 && arg.startsWith("-C") ? arg.slice(2) : args.shift() ?? "";
          const word = expandShellWord(raw, key => expansion.lookup(key), dialect);
          state.relocate(word ? placeShellPath(word, state.cwd, dialect) : null);
        } else if (arg.startsWith("-S") || arg === "--split-string" || arg.startsWith("--split-string=")) {
          args.shift();
          const raw = arg.startsWith("--split-string=") ? arg.slice(15) : arg.length > 2 && arg.startsWith("-S") ? arg.slice(2) : args.shift() ?? "";
          const payload = expandShellWord(raw, key => expansion.lookup(key), dialect)?.value;
          const decoded = payload === undefined ? null : envSplitPayload(payload, state);
          return { command, state, stdinTargets, payload: decoded === null ? null : [decoded, ...args].join(" ") };
        } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) { state.assign(arg, dialect, expansion); args.shift(); }
        else if (arg.startsWith("-")) return { command, state, stdinTargets, exhausted: true };
        else break;
      }
    } else {
      const values = WRAPPER_VALUES.get(name);
      if (!values) return { command: { ...command, name, rawArgs: args, args: args.map(raw => expandShellWord(raw, key => expansion.lookup(key), dialect)?.value ?? raw) }, state, stdinTargets };
      stdinTargets ||= name === "xargs";
      while (literal(args[0] ?? "").startsWith("-")) {
        const option = literal(args.shift() ?? "");
        if (option === "--") break;
        if (name === "command" && ["-v", "-V"].includes(option)) return { command: { ...command, name: "", args: [], rawArgs: [] }, state, stdinTargets };
        if (values.includes(option)) { if (args.shift() === undefined) return { command, state, stdinTargets, exhausted: true }; }
        else if (values.some(value => option.startsWith(`${value}=`) || (value.length === 2 && option.startsWith(value) && option.length > 2))) continue;
        else if (!WRAPPER_FLAGS.get(name)?.includes(option)) return { command, state, stdinTargets, exhausted: true };
      }
      if (name === "timeout" || name === "chrt") args.shift();
    }
    name = shellExecutable(literal(args.shift() ?? ""));
  }
  throw new Error("shell wrapper depth budget exhausted");
}
