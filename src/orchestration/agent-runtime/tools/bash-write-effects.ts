import type { ExpandedWord, ShellDialect } from "./bash-write-words.js";

export interface ShellOperand {
  readonly raw: string;
  readonly value: string;
  readonly word?: ExpandedWord | null;
}

/** The parts of one parsed shell command that name the files it writes. */
export interface ShellWriteCommand {
  readonly name: string;
  readonly args: readonly string[];
  readonly rawArgs: readonly string[];
  readonly operands?: readonly ShellOperand[];
  readonly heredocBody: string | null;
}

export interface ShellWriteEffect {
  readonly operand: ShellOperand | null;
  readonly effect: string;
  readonly deleteEntry?: boolean;
  readonly literal?: boolean;
  readonly directories?: readonly ShellOperand[];
}

const OPERAND_VALUE_OPTIONS = new Map<string, readonly string[]>([
  ["tee", ["--output-error"]],
  ["touch", ["-r", "--reference", "-d", "--date", "-t", "--time"]],
  ["mkdir", ["-m", "--mode"]],
  ["truncate", ["-s", "--size", "-r", "--reference"]],
  ["shred", ["-n", "--iterations", "-s", "--size", "--random-source"]],
  ["cp", ["-t", "--target-directory", "-S", "--suffix"]],
  ["mv", ["-t", "--target-directory", "-S", "--suffix"]],
  ["ln", ["-t", "--target-directory", "-S", "--suffix"]],
  ["install", ["-t", "--target-directory", "-m", "--mode", "-o", "--owner", "-g", "--group", "-S", "--suffix"]],
  ["chmod", ["--reference"]], ["chown", ["--reference"]], ["chgrp", ["--reference"]],
  ["rsync", ["-e", "--rsh", "--exclude", "--include", "--exclude-from", "--include-from", "--filter", "--files-from", "--backup-dir", "--suffix", "--log-file"]],
]);

/** Strip executable directories and a Windows executable suffix. */
export function shellExecutable(name: string): string {
  return (name.replaceAll("\\", "/").split("/").at(-1) ?? name).replace(/\.exe$/i, "");
}

function sliceOperand(operand: ShellOperand, offset: number): ShellOperand {
  return { raw: operand.raw, value: operand.value.slice(offset),
    ...(operand.word === undefined ? {} : { word: operand.word === null ? null : {
      value: operand.value.slice(offset),
      ...(operand.word.wildcard === undefined ? {} : { wildcard: Math.max(0, operand.word.wildcard - offset) }),
    } }),
  };
}

function literalOperand(value: string): ShellOperand { return { raw: value, value, word: { value } }; }

function optionValue(args: readonly ShellOperand[], names: readonly string[]): ShellOperand | undefined {
  for (let i = 0; i < args.length; i++) {
    const operand = args[i];
    if (!operand) continue;
    const arg = operand.value;
    if (names.includes(arg)) return args[i + 1];
    for (const name of names) {
      if (arg.startsWith(`${name}=`)) return sliceOperand(operand, name.length + 1);
      if (name.length === 2 && arg.startsWith(name) && arg.length > 2) return sliceOperand(operand, 2);
    }
  }
  return undefined;
}

function fileOperands(args: readonly ShellOperand[], values: readonly string[] = []): ShellOperand[] {
  const found: ShellOperand[] = [];
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const operand = args[i];
    if (!operand) continue;
    const arg = operand.value;
    if (!ended && arg === "--") ended = true;
    else if (!ended && arg.startsWith("-") && arg !== "-") {
      if (values.includes(arg)) i++;
    } else found.push(operand);
  }
  return found;
}

function tarDirectories(args: readonly ShellOperand[]) {
  const directories: ShellOperand[] = [];
  let extracts = false;
  for (let index = 0; index < args.length; index++) {
    const operand = args[index];
    if (!operand) continue;
    const arg = operand.value;
    if (arg === "--") break;
    if (arg === "--extract" || arg === "--get") extracts = true;
    else if (arg === "--directory") {
      const directory = args[++index];
      if (directory) directories.push(directory);
    } else if (arg.startsWith("--directory=")) directories.push(sliceOperand(operand, 12));
    else if (arg === "--file") index++;
    else if (!arg.startsWith("--") && (arg.startsWith("-") || index === 0 && /^[A-Za-z]+$/.test(arg))) {
      const oldStyle = !arg.startsWith("-");
      const flags = oldStyle ? arg : arg.slice(1);
      for (let offset = 0; offset < flags.length; offset++) {
        const flag = flags[offset];
        if (flag === "x") extracts = true;
        if (!flag || !"CfTbX".includes(flag)) continue;
        const attached = !oldStyle && offset + 1 < flags.length;
        const value = attached ? sliceOperand(operand, offset + 2) : args[++index];
        if (flag === "C" && value) directories.push(value);
        if (attached) break;
      }
    }
  }
  return { extracts, directories };
}

function powerShellEffects(command: ShellWriteCommand): ShellWriteEffect[] | null {
  const name = shellExecutable(command.name).toLowerCase();
  const deletes = ["remove-item", "rm", "del", "ri", "rd", "rmdir", "erase"];
  const writers = ["set-content", "add-content", "clear-content", "out-file", "tee-object", "new-item", "rename-item"];
  const transfers = ["copy-item", "move-item"];
  if (![...deletes, ...writers, ...transfers].includes(name)) return null;
  const args = command.rawArgs;
  const paths: string[] = [];
  const positional: string[] = [];
  let destination: string | undefined;
  const valueOptions = new Set(["-value", "-encoding", "-itemtype", "-newname", "-filter", "-include", "-exclude"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const colon = arg.indexOf(":");
    const lower = (colon >= 0 ? arg.slice(0, colon) : arg).toLowerCase();
    const value = (): string | undefined => colon >= 0 ? arg.slice(colon + 1) : args[++i];
    if (["-path", "-literalpath", "-filepath"].includes(lower)) {
      const path = value();
      if (path) paths.push(path);
      else paths.push("@");
    } else if (lower === "-destination") destination = value() ?? "@";
    else if (valueOptions.has(lower)) value();
    else if (!arg.startsWith("-")) positional.push(arg);
  }
  const source = paths.length > 0 ? paths : positional.slice(0, 1);
  const targets = (raw: string, effect: string, deleteEntry = false): ShellWriteEffect[] =>
    powerShellPaths(raw).map(path => ({ operand: path === null ? null : { raw: path, value: path }, effect, deleteEntry }));
  if (transfers.includes(name)) {
    const dest = destination ?? positional[paths.length > 0 ? 0 : 1] ?? ".";
    return [
      ...(name === "move-item" ? source.flatMap(raw => targets(raw, "delete", true)) : []),
      ...targets(dest, "copy"),
    ];
  }
  return (source.length ? source : ["@"]).flatMap(raw => targets(raw, deletes.includes(name) ? "delete" : name, deletes.includes(name)));
}

function powerShellPaths(raw: string): (string | null)[] {
  const paths: string[] = [];
  let start = 0;
  let quote = "";
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i] ?? "";
    if (quote) {
      if (char === quote) {
        if (raw[i + 1] === quote) i++;
        else quote = "";
      } else if (quote === '"' && (char === "`" || char === "$" && raw[i + 1] === "(")) return [null];
    } else if (char === "'" || char === '"') quote = char;
    else if ("(){}@`".includes(char)) return [null];
    else if (char === ",") { paths.push(raw.slice(start, i)); start = i + 1; }
  }
  if (quote) return [null];
  paths.push(raw.slice(start));
  return paths;
}

/** Recognized write operands only. Readers and opaque programs have no effects
 * here. Null targets represent inputs supplied at execution time. */
export function shellWriteEffects(command: ShellWriteCommand, dialect: ShellDialect, tmpdir: string | undefined, writes?: (command: ShellWriteCommand) => boolean): readonly ShellWriteEffect[] {
  if (dialect === "powershell") {
    const effects = powerShellEffects(command);
    if (effects) return effects;
  }
  const name = shellExecutable(command.name);
  const args = command.operands ?? command.rawArgs.map(raw => ({ raw, value: raw }));
  const has = (value: string): boolean => args.some(arg => arg.value === value);
  const files = fileOperands(args, OPERAND_VALUE_OPTIONS.get(name));
  const effect = (operand: ShellOperand | null, kind = name, deleteEntry = false): ShellWriteEffect => ({ operand, effect: kind, deleteEntry });
  switch (name) {
    case "rm": case "rmdir": case "unlink": return files.map(raw => effect(raw, "delete", true));
    case "shred": return files.filter(arg => arg.value !== "-").map(arg => effect(arg));
    case "tee": case "touch": case "mkdir": case "truncate": return files.map(arg => effect(arg));
    case "mv": {
      const directory = optionValue(args, ["-t", "--target-directory"]);
      return files.map((raw, i) => effect(raw, directory || i < files.length - 1 ? "delete" : "move", !!directory || i < files.length - 1))
        .concat(directory ? [effect(directory, "move")] : []);
    }
    case "cp": case "install": case "ln": {
      const target = optionValue(args, ["-t", "--target-directory"]) ?? (name === "ln" && files.length === 1 ? literalOperand(".") : files.at(-1));
      if (name === "install" && has("-d")) return files.map(raw => effect(raw));
      return target ? [effect(target, name === "ln" ? "link" : "copy", name === "ln")] : [];
    }
    case "rsync": return [
      ...(has("--remove-source-files") ? files.slice(0, -1).map(raw => effect(raw, "delete", true)) : []),
      ...(files.at(-1) ? [effect(files.at(-1) ?? null)] : []),
    ];
    case "dd": return args.filter(arg => arg.value.startsWith("of=")).map(arg => effect(sliceOperand(arg, 3)));
    case "chmod": case "chown": case "chgrp": return (args.some(arg => arg.value.startsWith("--reference")) ? files : files.slice(1)).map(raw => effect(raw));
    case "mktemp": {
      const directory = optionValue(args, ["-p", "--tmpdir"]);
      const template = fileOperands(args, ["-p", "--tmpdir", "--suffix"]).at(-1);
      const target = directory ?? (template?.value.includes("/") ? template : undefined);
      return [effect(target ?? literalOperand(tmpdir || "/tmp"), "mktemp", target === template)];
    }
    case "tar": {
      const parsed = tarDirectories(args);
      return parsed.extracts ? [{ ...effect(parsed.directories.at(-1) ?? literalOperand(".")), directories: parsed.directories }] : [];
    }
    case "unzip": return [effect(optionValue(args, ["-d"]) ?? literalOperand("."))];
    case "apply_patch": return patchEffects(command.heredocBody ?? command.args.join("\n"));
    case "find": return findTargets(args, dialect, tmpdir, writes).map(operand => effect(operand, "delete", true));
    default: return inPlaceTargets(command).map(raw => effect(raw, "in-place"));
  }
}

function findTargets(args: readonly ShellOperand[], dialect: ShellDialect, tmpdir: string | undefined, writes: ((command: ShellWriteCommand) => boolean) | undefined): readonly ShellOperand[] {
  const start = args.findIndex(arg => arg.value.startsWith("-") || arg.value === "(" || arg.value === "!");
  const roots = start < 0 ? args : args.slice(0, start);
  let writer = false;
  for (let i = Math.max(0, start); i < args.length; i++) {
    if (args[i]?.value === "-delete") writer = true;
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[i]?.value ?? "")) continue;
    const executable = args[++i]?.value ?? "";
    const nestedArgs: string[] = [];
    while (++i < args.length && !["+", ";", "\\;", "';'", '";"'].includes(args[i]?.value ?? "")) nestedArgs.push(args[i]?.value ?? "");
    const nested = { name: executable, args: nestedArgs, rawArgs: nestedArgs, heredocBody: null };
    writer ||= writes ? writes(nested) : shellWriteEffects(nested, dialect, tmpdir).length > 0;
  }
  return writer ? roots.length ? roots : [literalOperand(".")] : [];
}

function inPlaceTargets(command: ShellWriteCommand): readonly ShellOperand[] {
  switch (command.name) {
    case "sed":
      return command.args.some((arg) => arg === "-i" || arg === "--in-place" || /^-i./.test(arg) || arg.startsWith("--in-place=")) ? sedOperands(command) : [];
    case "perl":
      return command.args.some(isPerlInPlaceFlag) ? perlOperands(command) : [];
    case "awk":
      return command.args.some((arg, index) => arg === "-i" && command.args[index + 1] === "inplace") ? awkOperands(command) : [];
    default:
      return [];
  }
}

function isPerlInPlaceFlag(arg: string): boolean {
  if (!arg.startsWith("-") || arg.startsWith("--")) return false;
  const flags = arg.slice(1);
  if (!flags || flags.startsWith("M") || flags.startsWith("m") || flags.startsWith("I")) return false;
  const inPlaceIndex = flags.indexOf("i");
  if (inPlaceIndex < 0) return false;
  if (inPlaceIndex === 0) return true;
  return /^[A-Za-z0-9]+$/.test(flags.slice(0, inPlaceIndex));
}

// The raw text of each operand, with the program dropped: the first operand
// when no option supplied the program text.
function operands(command: ShellWriteCommand, takesValue: (arg: string) => boolean, suppliesProgram: (arg: string) => boolean, skipAfter: (arg: string, next: string | undefined) => boolean = () => false): ShellOperand[] {
  const found: ShellOperand[] = [];
  let programSupplied = false;
  let optionsEnded = false;
  for (let index = 0; index < command.args.length; index++) {
    const arg = command.args[index] ?? "";
    const raw = command.rawArgs[index] ?? arg;
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
    } else if (!optionsEnded && arg.startsWith("-") && arg !== "-") {
      if (suppliesProgram(arg)) programSupplied = true;
      if (takesValue(arg) || skipAfter(arg, command.args[index + 1])) index++;
    } else if (arg !== "") {
      found.push(command.operands?.[index] ?? { raw, value: arg });
    }
  }
  return programSupplied ? found : found.slice(1);
}

function sedOperands(command: ShellWriteCommand): ShellOperand[] {
  const program = (arg: string): boolean => ["-e", "-f", "--expression", "--file"].includes(arg);
  // BSD sed takes the backup suffix as its own argument: `sed -i '' ...`.
  const bsdSuffix = (arg: string, next: string | undefined): boolean => arg === "-i" && next !== undefined && (next === "" || next.startsWith("."));
  return operands(command, (arg) => program(arg) || arg === "-l", program, bsdSuffix);
}

function perlOperands(command: ShellWriteCommand): ShellOperand[] {
  const program = (arg: string): boolean => !arg.startsWith("--") && !arg.includes(".") && /[eE]$/.test(arg);
  return operands(command, program, program);
}

function awkOperands(command: ShellWriteCommand): ShellOperand[] {
  const program = (arg: string): boolean => arg === "-f" || arg === "-e";
  // A `name=value` operand is an awk variable assignment, not a file.
  return operands(command, (arg) => program(arg) || ["-v", "-F", "-i"].includes(arg), program)
    .filter((operand) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(operand.value));
}

const PATCH_PATH = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/gm;

function patchEffects(patch: string): ShellWriteEffect[] {
  return [...patch.matchAll(PATCH_PATH)].flatMap(match => match[2]
    ? [{ operand: { raw: match[2].trim(), value: match[2].trim() }, effect: "in-place", literal: true, deleteEntry: match[1] === "Delete File" }]
    : []);
}
