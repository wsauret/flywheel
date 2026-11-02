import { posix } from "node:path"
import type { ToolPresentation } from "../output-blocks.js"
import { fileSubject } from "./detail-helpers.js"
import { act, files, gitSubcommand, look, operands, programClause, type Clause, type Tier } from "./shell-programs.js"
import { parseShell, type ShellCommand } from "./shell-words.js"

const SEARCH_FLAGS = new Map<string, readonly string[]>([
  ...["rg", "rga", "ripgrep-all"].map((name) => [name, ["-g", "--glob", "--iglob", "-t", "--type", "--type-add", "--type-not", "-m", "--max-count", "-A", "-B", "-C", "--context", "--max-depth"]] as const),
  ...["grep", "egrep", "fgrep"].map((name) => [name, ["-m", "--max-count", "-A", "-B", "-C", "--context", "--include", "--exclude", "--exclude-dir"]] as const),
  ["ag", ["-m", "--max-count", "-A", "-B", "-C", "--context", "--max-depth", "-G", "--file-search-regex", "--ignore-dir", "--path-to-ignore"]],
  ["ack", ["-m", "--max-count", "-A", "-B", "-C", "--context", "-G", "--ignore-dir", "--ignore-file", "--type", "--type-add"]],
  ["pt", ["-g", "-G", "--ignore-dir", "--max-depth"]],
])
const LIST_FLAGS = new Map([
  ["ls", ["-I", "-w", "--block-size", "--format", "--time-style", "--color", "--quoting-style"]],
  ["eza", ["-I", "--ignore-glob", "--color", "--sort", "--time-style", "--time"]],
  ["exa", ["-I", "--ignore-glob", "--color", "--sort", "--time-style", "--time"]],
  ["tree", ["-L", "-P", "-I", "--charset", "--filelimit", "--sort"]],
  ["du", ["-d", "--max-depth", "-B", "--block-size", "--exclude", "--time-style"]],
])
const READ_FLAGS = new Map([
  ["bat", ["--theme", "--language", "--style", "--terminal-width", "--tabs", "--line-range", "--map-syntax"]],
  ["batcat", ["--theme", "--language", "--style", "--terminal-width", "--tabs", "--line-range", "--map-syntax"]],
  ["less", ["-p", "-P", "-x", "-y", "-z", "-j", "--pattern", "--prompt", "--tabs", "--shift", "--jump-target"]],
  ["nl", ["-s", "-w", "-v", "-i", "-b", "-f", "-h", "--starting-line-number", "--number-format", "--number-separator", "--number-width", "--section-delimiter", "--body-numbering", "--footer-numbering", "--header-numbering"]],
])
const TEXT_TOOL_FLAGS = ["-d", "-f", "-c", "-t", "-k", "-s", "-w", "-F", "-v", "-o"]
/** Shell grammar and output that a person does not read as work. */
const NOISE = new Set(["echo", "printf", "true", "false", ":", "date", "pwd", "clear", "set", "shopt", "trap", "unset", "source", ".", "exit",
  "return", "break", "continue", "wait", "test", "[", "[[", "read", "shift", "alias", "hash", "ulimit", "umask", "pushd", "popd", "history", "sync",
  "seq", "basename", "dirname", "realpath", "readlink", "tput", "id", "whoami", "hostname", "uname", "sw_vers"])
const SHELLS = new Set(["bash", "zsh", "sh", "dash"])
const POWERSHELLS = new Set(["pwsh", "pwsh.exe", "powershell", "powershell.exe"])
const RUNNERS = new Set(["uv", "poetry", "pipenv", "pdm", "hatch", "rye"])
const WRAPPERS = new Map<string, readonly string[]>([
  ["time", []], ["nohup", []], ["builtin", []], ["exec", []], ["caffeinate", []], ["stdbuf", []], ["arch", []],
  ["sudo", ["-u", "-g"]], ["nice", ["-n"]], ["timeout", ["-s", "-k", "--signal", "--kill-after"]], ["gtimeout", ["-s", "-k", "--signal", "--kill-after"]],
])
const RUNNER_FLAGS = ["--with", "--python", "-p", "--project", "--directory", "--env-file", "--extra", "--group", "--package", "--from"]
const XARGS_FLAGS = ["-E", "-e", "-I", "-L", "-n", "-P", "-s", "-d"]
const OUTPUT_ONLY = new Set(["echo", "printf", "cat"])

/** Whether a sed script only prints. A `w`, `W`, or `e` command writes a file or runs one. */
const printOnlySed = (script: string) => !/(?:^|[;{}\n]|\/[gpIi0-9]*)\s*[wWe](?:\s|$)/.test(script)
const printOnlyAwk = (script: string) => !/system\s*\(|print[f]?\s*[^;]*>|\|\s*"/.test(script)

function sedPaths(args: readonly string[]): readonly string[] | undefined {
  if (args[0] !== "-n") return undefined
  const scriptAt = ["-e", "--expression"].includes(args[1] ?? "") ? 2 : 1
  if (!/^\d+(?:,\d+)?p(?:;\s*\d+(?:,\d+)?p)*$/.test(args[scriptAt] ?? "")) return undefined
  const paths = args.slice(scriptAt + 1)
  return paths.some((arg) => arg.startsWith("-")) ? undefined : paths
}

/** The files a print-only reader shows, or nothing when the command is not one. */
function readPaths(head: string, args: readonly string[]): readonly string[] | undefined {
  switch (head.toLowerCase()) {
    case "cat": case "more": return operands(args, [])
    case "get-content": case "gc": case "type":
      if (args.some((arg) => arg.startsWith("-") && !["-raw", "-path", "-literalpath"].includes(arg.toLowerCase()))) return undefined
      return operands(args, [])
    case "head": case "tail": {
      for (let i = 0; i < args.length; i++) {
        const arg = args[i] ?? ""
        if (arg === "-n" || arg === "-c") {
          if (!(head === "tail" ? /^\+?\d+$/ : /^-?\d+$/).test(args[++i] ?? "")) return undefined
        } else if (arg.startsWith("-") && arg !== "--" && !/^-(?:[nc]\+?\d+|\d+|[fqF])$/.test(arg)) return undefined
      }
      return operands(args, ["-n", "-c"])
    }
    case "bat": case "batcat": case "less": case "nl": return operands(args, READ_FLAGS.get(head.toLowerCase()) ?? [])
    case "sed": return sedPaths(args) ?? (args[0] !== "-i" && !args.includes("-i") && printOnlySed(args.find((arg) => !arg.startsWith("-")) ?? "") ? operands(args, ["-e", "-f"]).slice(1) : undefined)
    case "awk": return printOnlyAwk(args[0] ?? "") && !args.includes("-f") ? args.slice(1).filter((arg) => !arg.startsWith("-v") && !arg.includes("=")) : undefined
    case "jq": return operands(args, ["--arg", "--argjson", "--slurpfile", "--rawfile", "--indent"]).slice(1)
    case "cut": case "tr": case "sort": case "uniq": case "column": case "fold": case "rev": case "tac": case "paste": case "fmt":
      if (args.some((arg) => /^-[^-]*o/.test(arg) || arg.startsWith("--output"))) return undefined
      return operands(args, TEXT_TOOL_FLAGS).slice(head === "tr" ? 2 : 0)
    case "wc": return operands(args, [])
    default: return undefined
  }
}

/** A command in a pipeline that only shapes the output before it. */
function filters(head: string, args: readonly string[]): boolean {
  if (head === "xargs") {
    const command = operands(args, XARGS_FLAGS)
    return command.length === 0 || ["wc", "head", "tail", "cat", "printf", "echo"].includes(command[0] ?? "")
  }
  if (head === "python3" || head === "python") return args[0] === "-m" && args[1] === "json.tool"
  if (["grep", "egrep", "fgrep", "rg", "ag"].includes(head)) {
    const explicit = args.some((arg) => ["-e", "--regexp", "-f", "--file"].includes(arg))
    return operands(args, [...(SEARCH_FLAGS.get(head) ?? []), "-e", "--regexp", "-f", "--file"]).length <= (explicit ? 0 : 1)
  }
  if (["yes", "printf", "less", "more"].includes(head)) return true
  if (head === "tee") return false
  return readPaths(head, args)?.length === 0
}

function search(head: string, args: readonly string[]): Clause | undefined {
  const searchFlags = SEARCH_FLAGS.get(head)
  if (searchFlags === undefined) return undefined
  const explicit = args.findIndex((arg) => ["-e", "--regexp", "-f", "--file"].includes(arg))
  const positional = operands(args, [...searchFlags, "-e", "--regexp", "-f", "--file"])
  if (args.includes("--files")) return look("Listed", directory(positional[0] ?? "."))
  const query = explicit < 0 ? positional[0] : args[explicit + 1]
  const path = explicit < 0 ? positional[1] : positional[0]
  return look("Searched", [query, path === undefined ? undefined : `in ${directory(path)}`].filter(Boolean).join(" "))
}

function find(head: string, args: readonly string[], cwd: string): Clause | undefined {
  const valueFlags = head === "find" ? ["-type", "-maxdepth", "-mindepth", "-name", "-iname", "-path", "-ipath", "-regex", "-newer", "-mtime", "-size", "-not"]
    : ["-t", "--type", "-e", "--extension", "-E", "--exclude", "--search-path", "-d", "--max-depth"]
  if (head === "find" && args.includes("-delete")) return act("Removed", `files in ${operands(args, valueFlags)[0] ?? "."}`)
  const execAt = args.findIndex((arg) => arg === "-exec" || arg === "-execdir")
  const own = execAt < 0 ? args : args.slice(0, execAt)
  const positional = operands(own, valueFlags).filter((arg) => arg !== "!" && arg !== "(" && arg !== ")")
  const selector = own.findIndex((arg) => ["-name", "-iname", "-path", "-ipath", "-regex"].includes(arg))
  const first = positional[0]
  const query = head === "find" ? (selector < 0 ? undefined : own[selector + 1])
    : positional.length === 1 && (first === "." || first === ".." || /[/\\]/.test(first ?? "")) ? undefined : first
  const path = head === "find" || query === undefined ? first : positional[1]
  return query === undefined ? look("Listed", directory(path ?? (cwd || "."))) : look("Searched", `${query}${path === undefined ? "" : ` in ${directory(path)}`}`)
}

/** A searched or listed place, by its last two names when its full path is
 *  longer than a person reads at a glance. */
function directory(path: string): string {
  const segments = path.replace(/[/\\]+$/, "").split(/[/\\]/)
  return segments.length > 3 ? segments.slice(-2).join("/") : path
}

const PY_LISTING = /^import (os|glob);\s*print\((?:os\.listdir|glob\.glob)\((?:'([^'\\]*)'|"([^"\\]*)")\)\)$/

/** File work the shell itself names: reads, searches, listings, and edits. */
function fileClause(head: string, args: readonly string[], cwd: string): Clause | undefined {
  if ((head === "sed" || head === "perl" || head === "ruby") && args.some((arg) => /^-[^-]*i/.test(arg))) {
    const targets = operands(args, ["-e", "-f", "--expression", "-E"]).filter((arg) => arg !== "")
    return act("Edited", files(args.some((arg) => ["-e", "-f", "--expression", "-E"].includes(arg)) ? targets : targets.slice(1)) || "files")
  }
  const read = readPaths(head, args)
  if (read !== undefined && read.length > 0) {
    if (head === "wc") return look("Counted", `${args.includes("-c") ? "bytes" : args.includes("-w") ? "words" : "lines"} in ${files(read)}`)
    return look("Read", files(read.map((path) => posix.join(cwd, path))))
  }
  const listFlags = LIST_FLAGS.get(head)
  if (listFlags !== undefined) return look("Listed", directory(operands(args, listFlags)[0] ?? (cwd || ".")))
  if (head === "git") {
    const { sub, rest } = gitSubcommand(args)
    if (sub === "grep") return search("grep", rest)
    if (sub === "ls-files") return look("Listed", operands(rest, ["--exclude", "--exclude-from", "--pathspec-from-file"])[0] ?? (cwd || "."))
  }
  if (head === "fd" || head === "find") return find(head, args, cwd)
  if (/^python(?:[23](?:\.\d+)?)?$/.test(head) && args.length === 2 && args[0] === "-c") {
    const listing = PY_LISTING.exec(args[1] ?? "")
    if (listing !== null) return look("Listed", listing[1] === "os" ? posix.join(cwd, listing[2] ?? listing[3] ?? ".") : cwd || ".")
  }
  return search(head, args)
}

/** Where the program a command runs starts, past environment and launcher wrappers. */
function unwrap(words: readonly string[]): number {
  let i = 0
  const skipFlags = (valueFlags: readonly string[]) => {
    while ((words[i] ?? "").startsWith("-")) i += valueFlags.includes(words[i] ?? "") ? 2 : 1
  }
  for (;;) {
    const head = fileSubject(words[i] ?? "")
    if (head === "env") {
      i++
      while ((words[i] ?? "").startsWith("-") || /^[A-Za-z_]\w*=/.test(words[i] ?? "")) i += ["-u", "-C", "-S"].includes(words[i] ?? "") ? 2 : 1
    } else if (head === "direnv" && words[i + 1] === "exec") i += 3
    else if (RUNNERS.has(head) && (words[i + 1] === "run" || (words[i + 1] === "tool" && words[i + 2] === "run"))) {
      i += words[i + 1] === "run" ? 2 : 3
      skipFlags(RUNNER_FLAGS)
    } else if (["npx", "bunx", "pnpx", "uvx"].includes(head)) {
      i++
      skipFlags(["-p", "--package"])
    } else if (["npm", "pnpm", "yarn"].includes(head) && ["exec", "dlx"].includes(words[i + 1] ?? "")) i += 2
    else if (WRAPPERS.has(head)) {
      i++
      skipFlags(WRAPPERS.get(head) ?? [])
      if (head === "timeout" || head === "gtimeout") i++
    } else return i
  }
}

/** A path argument of a command that presents as itself, by its file name. */
const shortPath = (word: string) => /^[^-][^:]*[/\\][^/\\]/.test(word) && !/^[a-z]+:\/\//i.test(word) ? fileSubject(word) : word

/** The clauses of one simple command, given the directory earlier commands changed to. */
function commandClauses(command: ShellCommand, cwd: string): readonly Clause[] {
  const at = unwrap(command.words)
  const words = command.words.slice(at)
  const head = fileSubject(words[0] ?? "")
  const args = words.slice(1)
  const writes = command.writes.map((path) => act("Wrote", fileSubject(path)))
  if (words.length === 0) return writes
  if (SHELLS.has(head) && ["-c", "-lc", "-ec", "-ic"].includes(args[0] ?? "")) return [...lineClauses(args[1] ?? ""), ...writes]
  if (POWERSHELLS.has(head.toLowerCase())) {
    const scriptAt = args.findIndex((arg) => ["-command", "-c"].includes(arg.toLowerCase()))
    if (scriptAt >= 0) return [...lineClauses(args[scriptAt + 1] ?? ""), ...writes]
  }
  if (head === "ssh") {
    const [host = "", ...remote] = operands(args, ["-i", "-p", "-o", "-F", "-J", "-l", "-L", "-R"])
    return lineClauses(remote.join(" ")).map((clause) => ({ ...clause, detail: `${clause.detail} on ${host}` }))
  }
  if (head === "xargs") {
    if (command.pipedIn && filters(head, args)) return writes
    let start = 0
    while ((args[start] ?? "").startsWith("-")) start += XARGS_FLAGS.includes(args[start] ?? "") ? 2 : 1
    return [...nestedClauses(command, args.slice(start), cwd), ...writes]
  }
  if (head === "find") {
    const execAt = args.findIndex((arg) => arg === "-exec" || arg === "-execdir")
    if (execAt >= 0) {
      const end = args.findIndex((arg, index) => index > execAt && (arg === ";" || arg === "+"))
      const inner = args.slice(execAt + 1, end < 0 ? args.length : end).filter((arg) => arg !== "{}")
      const found = fileClause(head, args.slice(0, execAt), cwd)
      return [...nestedClauses(command, inner, cwd), ...(found === undefined ? [] : [found]), ...writes]
    }
  }
  if (head === "tee") return files(operands(args, [])) === "" ? [] : [act("Wrote", files(operands(args, [])))]
  if (NOISE.has(head) || (OUTPUT_ONLY.has(head) && operands(args, []).length === 0)) return writes
  if (command.pipedIn && filters(head, args)) return writes
  const clause = fileClause(head, args, cwd) ?? programClause(head, args, command)
    ?? (SHELLS.has(head) && args[0] !== undefined ? act("Ran", fileSubject(args[0])) : undefined)
    ?? (/[/\\]/.test(words[0] ?? "") ? act("Ran", head) : act("Ran", command.shown.slice(at).map(shortPath).join(" ")))
  return [clause, ...writes]
}

/** The clauses of a command that another command runs, such as `xargs` or `find -exec`. */
function nestedClauses(outer: ShellCommand, words: readonly string[], cwd: string): readonly Clause[] {
  return commandClauses({ ...outer, words, shown: words, pipedIn: false, writes: [] }, cwd)
}

function lineClauses(line: string): readonly Clause[] {
  const clauses: Clause[] = []
  let cwd = ""
  for (const command of parseShell(line)) {
    const [head, ...args] = command.words
    if (head === "cd") {
      const target = args.includes("--") ? args[args.indexOf("--") + 1] : operands(args, []).at(-1)
      if (target !== undefined) cwd = posix.isAbsolute(target) ? target : posix.join(cwd, target)
      continue
    }
    clauses.push(...commandClauses(command, cwd))
  }
  return clauses
}

const TIERS: readonly Tier[] = ["act", "look", "setup"]

/** One sentence for a whole line: what it changes or runs first, then what
 *  it looks at, each verb once with its subjects in the order they ran. */
function compose(clauses: readonly Clause[]): ToolPresentation | undefined {
  const shown = clauses.some((clause) => clause.tier !== "setup") ? clauses.filter((clause) => clause.tier !== "setup") : clauses
  const groups = new Map<string, string[]>()
  for (const tier of TIERS) {
    for (const clause of shown) {
      if (clause.tier !== tier) continue
      const details = groups.get(clause.name) ?? []
      if (clause.detail !== "" && !details.includes(clause.detail)) details.push(clause.detail)
      groups.set(clause.name, details)
    }
  }
  const [first, ...rest] = groups
  if (first === undefined) return undefined
  return { name: first[0], detail: `${first[1].join(", ")}${rest.map(([name, details]) => `; ${`${name} ${details.join(", ")}`.trim()}`).join("")}` }
}

/** Present a shell command as what it does: its reads, searches, edits, and
 *  the programs it runs. A command none of those describe presents as itself,
 *  without its directory changes, environment wrappers, and output shaping. */
export function shellSentence(command: string): ToolPresentation {
  const sentence = compose(lineClauses(command))
  if (sentence !== undefined) return sentence
  const first = parseShell(command).find((parsed) => parsed.words.length > 0)
  return { name: "Ran", detail: first === undefined ? command : first.shown.join(" ") }
}
