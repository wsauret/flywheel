import { fileSubject } from "./detail-helpers.js"
import type { ShellCommand } from "./shell-words.js"

/** What a clause says about the purpose of a command line. What it changes
 *  or runs leads the sentence, what it looks at follows, and setup such as
 *  `mkdir` or `sleep` shows only when the line does nothing else. */
export type Tier = "act" | "look" | "setup"

/** One past-tense verb and its subject for one command of a line. */
export interface Clause {
  readonly name: string
  readonly detail: string
  readonly tier: Tier
}

export const act = (name: string, detail: string): Clause => ({ name, detail, tier: "act" })
export const look = (name: string, detail: string): Clause => ({ name, detail, tier: "look" })
const setup = (name: string, detail: string): Clause => ({ name, detail, tier: "setup" })

/** Arguments that are not options, skipping the value of each option in `valueFlags`. */
export function operands(args: readonly string[], valueFlags: readonly string[]): string[] {
  const result: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ""
    if (arg === "--") return [...result, ...args.slice(i + 1)]
    if (valueFlags.includes(arg)) i++
    else if (!arg.startsWith("-") || arg === "-") result.push(arg)
  }
  return result
}

/** The value of the first option named in `flags`, in either `-f value` or `--flag=value` form. */
function option(args: readonly string[], flags: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ""
    if (flags.includes(arg)) return args[i + 1]
    const joined = flags.find((flag) => flag.startsWith("--") && arg.startsWith(`${flag}=`))
    if (joined !== undefined) return arg.slice(joined.length + 1)
  }
  return undefined
}

/** File names as a person reads them. A path that only a substitution
 *  produces has no name until the command runs. */
export const files = (paths: readonly string[]): string =>
  [...new Set(paths.map((path) => (/^(?:\$\(|`|<\()/.test(path) ? "matching files" : fileSubject(path))))].join(", ")

/** A URL without its scheme or query, as a person names a page. */
export function displayUrl(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/[?#].*$/, "").replace(/\/$/, "")
}

const SQL_TABLE = /\b(?:from|join|into|update|table|describe|desc)\s+((?:[A-Za-z_][\w$]*|"[^"]+")(?:\.(?:[A-Za-z_][\w$]*|"[^"]+"))*)/gi
const NOT_TABLES = new Set(["select", "lateral", "table", "values", "the", "if"])

/** The first table a SQL text reads or writes, for a query that names one. */
function sqlTable(sql: string): string | undefined {
  const text = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "")
  for (const match of text.matchAll(SQL_TABLE)) {
    const name = match[1] ?? ""
    if (!NOT_TABLES.has(name.toLowerCase())) return name
  }
  return undefined
}

/** A query's subject, or the script that holds it. */
function query(system: string, file: string | undefined, sql: string | undefined): Clause {
  if (file !== undefined) return act("Ran", `${fileSubject(file)} in ${system}`)
  return act("Queried", (sql === undefined ? undefined : sqlTable(sql)) ?? system)
}

const FILE_LITERAL = /["'`]([^"'`\s]*?[\w-]+\.(?:jsonl?|csv|tsv|sql|py|tsx?|jsx?|mjs|md|txt|ya?ml|toml|log|parquet|html|xml|sqlite))["'`]/

/** Code passed inline to an interpreter, named by the file it works on when it names one. */
function inline(language: string, code: string, args: readonly string[]): Clause {
  const paths = args.filter((arg) => /^\S+$/.test(arg) && (/[/\\]/.test(arg) || /\.\w{1,8}$/.test(arg)))
  const subject = paths.length > 0 ? files(paths) : fileSubject(FILE_LITERAL.exec(code)?.[1] ?? "")
  return act("Ran", subject === "" ? language : `${language} on ${subject}`)
}

/** Split git's own options from its subcommand. */
export function gitSubcommand(args: readonly string[]) {
  let i = 0
  while (i < args.length && (args[i] ?? "").startsWith("-")) i += ["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(args[i] ?? "") ? 2 : 1
  return { sub: args[i], rest: args.slice(i + 1) }
}

const GIT_LOG_FLAGS = ["-n", "--max-count", "--author", "--grep", "--since", "--until", "--format", "--pretty", "-S", "-G", "--date", "-L", "--skip"]
/** Git subcommands that only inspect refs, remotes, and configuration. */
const GIT_REF_COMMANDS = new Set("rev-parse merge-base rev-list ls-remote remote describe config cat-file for-each-ref symbolic-ref name-rev check-ignore show-ref count-objects var ls-tree cherry check-attr".split(" "))

/** One git invocation: its options and operands, and the paths after `--`. */
interface GitCall {
  readonly rest: readonly string[]
  readonly positional: readonly string[]
  readonly paths: readonly string[]
}

const has = (args: readonly string[], flags: readonly string[]) => args.some((arg) => flags.includes(arg))

function gitShow({ positional }: GitCall): Clause {
  const [ref = "HEAD"] = positional
  const at = ref.indexOf(":")
  return at >= 0 && at < ref.length - 1 ? look("Read", `${fileSubject(ref.slice(at + 1))} at ${ref.slice(0, at) || "index"}`) : look("Showed", positional.join(", ") || ref)
}

function gitSwitch({ rest, positional, paths }: GitCall): Clause {
  if (paths.length > 0) return act("Restored", files(paths))
  const created = option(rest, ["-b", "-B", "-c", "-C"])
  return created === undefined ? act("Switched", `to ${positional[0] ?? "branch"}`) : act("Created", `branch ${created}`)
}

function gitBranch({ rest, positional }: GitCall): Clause {
  if (has(rest, ["-d", "-D", "--delete"])) return act("Deleted", `branch ${positional.join(", ")}`)
  return positional.length > 0 && !has(rest, ["--list", "-l", "-a", "-r", "--contains", "--merged"]) ? act("Created", `branch ${positional[0]}`) : look("Listed", "branches")
}

function gitWorktree({ rest }: GitCall): Clause | undefined {
  const target = fileSubject(operands(rest.slice(1), ["-b", "-B", "--reason"])[0] ?? "")
  if (rest[0] === "add") return act("Created", `worktree ${target}`)
  if (rest[0] === "remove") return act("Removed", `worktree ${target}`)
  if (rest[0] === "list") return look("Listed", "worktrees")
  return rest[0] === "prune" ? setup("Pruned", "worktrees") : undefined
}

const gitLog = ({ positional, paths }: GitCall) => look("Read", ["git log", ...positional, ...(paths.length > 0 ? [`of ${files(paths)}`] : [])].join(" "))
const gitDiff = ({ rest, positional, paths }: GitCall) => look("Diffed", paths.length > 0 ? files(paths) : positional.length > 0 ? positional.join(" ")
  : has(rest, ["--cached", "--staged"]) ? "staged changes" : "working tree")

const GIT = new Map<string, (call: GitCall) => Clause | undefined>([
  ["status", () => look("Checked", "git status")],
  ["diff", gitDiff],
  ["show", gitShow],
  ...["log", "shortlog", "reflog", "whatchanged"].map((name) => [name, gitLog] as const),
  ["blame", ({ positional, paths }) => look("Read", `blame of ${fileSubject(positional.at(-1) ?? paths.at(-1) ?? "")}`)],
  ["add", ({ rest, positional, paths }) => act("Staged", has(rest, ["-A", "--all", "."]) ? "all changes" : files([...positional, ...paths]))],
  ["commit", ({ rest }) => act("Committed", option(rest, ["-m", "--message", "-am"])?.split("\n")[0] ?? (rest.includes("--amend") ? "an amend" : "changes"))],
  ["push", ({ positional }) => act("Pushed", positional.slice(1).join(", ") || positional[0] || "commits")],
  ["fetch", ({ positional }) => act("Fetched", positional.join(" ") || "the default remote")],
  ["pull", ({ positional }) => act("Pulled", positional.join(" ") || "the default remote")],
  ["merge", ({ positional }) => act("Merged", positional.join(", "))],
  ["rebase", ({ positional }) => act("Rebased", positional.length > 0 ? `onto ${positional.at(-1)}` : "branch")],
  ["cherry-pick", ({ positional }) => act("Cherry-picked", positional.join(", "))],
  ["revert", ({ positional }) => act("Reverted", positional.join(", "))],
  ["restore", ({ positional, paths }) => act("Restored", files([...positional, ...paths]))],
  ["checkout", gitSwitch],
  ["switch", gitSwitch],
  ["reset", ({ positional }) => act("Reset", positional.length > 0 ? `to ${positional[0]}` : "staged changes")],
  ["branch", gitBranch],
  ["worktree", gitWorktree],
  ["tag", ({ rest, positional }) => positional.length > 0 && !rest.includes("-l") ? act("Tagged", positional[0] ?? "") : look("Listed", "tags")],
  ["apply", ({ positional }) => act("Applied", files(positional) || "patch")],
  ["am", ({ positional }) => act("Applied", files(positional) || "patch")],
  ["clone", ({ positional }) => act("Cloned", displayUrl(positional[0] ?? ""))],
])

function git(args: readonly string[]): Clause | undefined {
  const { sub, rest } = gitSubcommand(args)
  if (sub === undefined) return undefined
  const split = rest.indexOf("--")
  const positional = operands(split < 0 ? rest : rest.slice(0, split), GIT_LOG_FLAGS)
  const handler = GIT.get(sub)
  if (handler !== undefined) return handler({ rest, positional, paths: split < 0 ? [] : rest.slice(split + 1) })
  return GIT_REF_COMMANDS.has(sub) ? look("Checked", ["git", sub, ...positional].join(" ")) : undefined
}

const GH_NOUNS = new Map<string, readonly [string, string]>([
  ["pr", ["PR", "PRs"]], ["issue", ["issue", "issues"]], ["run", ["run", "runs"]], ["release", ["release", "releases"]],
  ["repo", ["repo", "repos"]], ["workflow", ["workflow", "workflows"]], ["gist", ["gist", "gists"]], ["label", ["label", "labels"]],
])
const GH_VERBS = new Map<string, readonly [string, Tier]>([
  ["view", ["Viewed", "look"]], ["list", ["Listed", "look"]], ["diff", ["Diffed", "look"]], ["checks", ["Checked", "look"]], ["status", ["Checked", "look"]],
  ["watch", ["Watched", "look"]], ["create", ["Created", "act"]], ["edit", ["Edited", "act"]], ["merge", ["Merged", "act"]], ["comment", ["Commented on", "act"]],
  ["rerun", ["Reran", "act"]], ["close", ["Closed", "act"]], ["reopen", ["Reopened", "act"]], ["review", ["Reviewed", "act"]], ["checkout", ["Checked out", "act"]],
  ["ready", ["Marked ready", "act"]], ["download", ["Downloaded", "act"]], ["cancel", ["Cancelled", "act"]], ["delete", ["Deleted", "act"]], ["clone", ["Cloned", "act"]],
])
const GH_FLAGS = ["-R", "--repo", "--json", "-q", "--jq", "-t", "--title", "-b", "--body", "-F", "--body-file", "-B", "--base", "-H", "--head",
  "-L", "--limit", "-s", "--state", "--template", "-a", "--assignee", "-l", "--label", "-m", "--milestone", "--job", "-X", "--method",
  "-f", "--field", "--raw-field", "--header", "--hostname", "-w", "--workflow", "--branch", "-c", "--commit", "-e", "--event", "--author", "--search"]

function gh(args: readonly string[]): Clause | undefined {
  const [noun = "", verb = "", target] = operands(args, GH_FLAGS)
  if (noun === "auth" && verb === "status") return look("Checked", "GitHub login")
  if (noun === "api") {
    const method = option(args, ["-X", "--method"])?.toUpperCase()
    const writes = (method !== undefined && method !== "GET") || args.some((arg) => ["-f", "-F", "--field", "--raw-field"].includes(arg))
    return (writes ? act : look)("Called", `GitHub API ${displayUrl(verb)}`)
  }
  const names = GH_NOUNS.get(noun)
  const action = GH_VERBS.get(verb)
  if (names === undefined || action === undefined) return undefined
  const [name, tier] = action
  if (verb === "list") return { name, detail: names[1], tier }
  const title = verb === "create" ? option(args, ["-t", "--title"]) : undefined
  return { name, detail: [names[0], target ?? title].filter(Boolean).join(" "), tier }
}

const DBT_SELECT = ["-s", "--select", "-m", "--models", "--model"]

function dbt(args: readonly string[]): Clause | undefined {
  const sub = args.find((arg) => !arg.startsWith("-"))
  const selected = option(args, DBT_SELECT)
  const or = (fallback: string) => selected ?? fallback
  switch (sub) {
    case "test": return act("Tested", or("dbt project"))
    case "build": return act("Built", or("dbt project"))
    case "run": return act("Ran", selected === undefined ? "dbt models" : `dbt models ${selected}`)
    case "compile": return act("Compiled", or("dbt project"))
    case "seed": return act("Seeded", or("dbt seeds"))
    case "snapshot": return act("Snapshotted", or("dbt snapshots"))
    case "show": {
      const sql = option(args, ["--inline"])
      return sql === undefined ? look("Previewed", or("dbt model")) : act("Queried", sqlTable(sql) ?? "dbt")
    }
    case "ls": case "list": return look("Listed", selected === undefined ? "dbt models" : `dbt models ${selected}`)
    case "parse": return act("Parsed", "dbt project")
    case "deps": return act("Installed", "dbt packages")
    case "debug": return look("Checked", "dbt connection")
    case "clean": return setup("Cleaned", "dbt targets")
    case "run-operation": return act("Ran", `dbt macro ${operands(args, ["--args"])[1] ?? ""}`.trim())
    default: return undefined
  }
}

const TEST_FLAGS = ["-k", "-m", "-p", "-c", "-o", "--tb", "--rootdir", "-n", "--maxfail", "--deselect", "--ignore", "--durations", "--junitxml",
  "--cov", "--log-level", "--basetemp", "-t", "--test-name-pattern", "--timeout", "--preload", "--reporter", "--project", "--config"]

function tested(runner: string, args: readonly string[]): Clause {
  const targets = operands(args, TEST_FLAGS).filter((arg) => arg !== "run")
  return act("Tested", targets.length > 0 ? files(targets) : `with ${runner}`)
}

const FORMATTERS = new Set(["black", "isort", "autopep8", "gofmt", "rustfmt"])
const CHECKERS = new Set(["ruff", "eslint", "oxlint", "tsc", "mypy", "pyright", "sqlfluff", "pre-commit", "prettier", "shellcheck", "biome", "flake8", "pylint", "yamllint", ...FORMATTERS])
const CHECKER_WORDS = new Set(["check", "format", "lint", "run", "fix"])
const CHECKER_FLAGS = ["--config", "-c", "--project", "-p", "--select", "--ignore", "--dialect", "--templater", "--hook-stage", "--from-ref", "--to-ref", "--line-length", "--target-version", "--max-warnings", "--ext", "--format"]

function checked(tool: string, args: readonly string[]): Clause {
  const targets = operands(args, CHECKER_FLAGS).filter((arg) => !CHECKER_WORDS.has(arg))
  const subject = targets.length > 0 ? `${files(targets)} with ${tool}` : `with ${tool}`
  const rewrites = (FORMATTERS.has(tool) && !args.includes("--check")) || args.includes("--write") || args.includes("--fix")
    || (["ruff", "biome", "sqlfluff"].includes(tool) && (args.includes("format") || args.includes("fix")) && !args.includes("--check"))
  return rewrites ? act("Formatted", subject) : act("Checked", subject)
}

const INSTALL_WORDS = new Set(["install", "i", "add", "ci", "sync"])

function installed(args: readonly string[]): Clause {
  return act("Installed", files(operands(args, ["-p", "--prefix", "--target", "-r", "--requirement", "--index-url", "--python"]).filter((arg) => !INSTALL_WORDS.has(arg) && arg !== "pip")) || "dependencies")
}

const PYTHON = /^python(?:[23](?:\.\d+)?)?$/
const SCRIPT_FILE = /[/\\]|\.(?:[cm]?[jt]sx?|py|sh|rb|pl)$/
const JS_EVAL = new Set(["-e", "--eval", "-p", "--print"])

function python(args: readonly string[], command: ShellCommand): Clause | undefined {
  if (args[0] === "-m") {
    const [module = "", ...rest] = args.slice(1)
    if (module === "pytest") return tested("pytest", rest)
    return module === "json.tool" && command.pipedIn ? undefined : act("Ran", module)
  }
  const codeAt = args.indexOf("-c")
  if (codeAt >= 0) return inline("Python", args[codeAt + 1] ?? "", args.slice(codeAt + 2))
  const [script, ...rest] = operands(args, ["-W", "-X"])
  if (script === "-" || (script === undefined && command.stdin !== undefined)) return inline("Python", command.stdin ?? "", rest)
  return script === undefined ? undefined : act("Ran", fileSubject(script))
}

function javascript(runtime: string, args: readonly string[], command: ShellCommand): Clause | undefined {
  const evalAt = args.findIndex((arg) => JS_EVAL.has(arg))
  if (evalAt >= 0) return inline("JavaScript", args[evalAt + 1] ?? "", [])
  const [first, ...rest] = operands(args, ["--conditions", "-r", "--require", "--import", "--preload", "--cwd"])
  if (runtime === "bun") {
    if (first === "test") return tested("bun test", rest)
    if (first !== undefined && INSTALL_WORDS.has(first)) return installed(rest)
    if (first === "run" && rest[0] !== undefined) {
      if (SCRIPT_FILE.test(rest[0])) return act("Ran", fileSubject(rest[0]))
      if (/^test(?::|$)/.test(rest[0]) && rest.length > 1) return tested(`bun run ${rest[0]}`, rest.slice(1))
    }
  }
  if (first === undefined) return command.stdin === undefined ? undefined : inline("JavaScript", command.stdin, [])
  return SCRIPT_FILE.test(first) ? act("Ran", fileSubject(first)) : undefined
}

function packageManager(tool: string, args: readonly string[]): Clause | undefined {
  const [first, script, ...rest] = operands(args, [])
  if (first !== undefined && INSTALL_WORDS.has(first)) return installed(args.slice(1))
  if (first === "run" && script !== undefined && /^test(?::|$)/.test(script) && rest.length > 0) return tested(`${tool} run ${script}`, rest)
  return first === "test" ? tested(`${tool} test`, args.slice(1)) : undefined
}

const CURL_FLAGS = ["-X", "--request", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "-o", "--output", "-u", "--user",
  "-A", "--user-agent", "-e", "--referer", "--max-time", "-m", "--connect-timeout", "-w", "--write-out", "-b", "--cookie", "-c", "--cookie-jar",
  "--cacert", "--cert", "-F", "--form", "--retry", "--unix-socket", "-T", "--upload-file", "-K", "--config"]

function fetched(args: readonly string[]): Clause | undefined {
  const url = operands(args, CURL_FLAGS)[0]
  if (url === undefined) return undefined
  const sends = args.some((arg) => ["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "-F", "--form", "-T", "--upload-file"].includes(arg))
  const method = option(args, ["-X", "--request"])?.toUpperCase() ?? (sends ? "POST" : "GET")
  return method === "GET" ? act("Fetched", displayUrl(url)) : act("Sent", `${method} ${displayUrl(url)}`)
}

function moved(name: string, args: readonly string[], valueFlags: readonly string[]): Clause | undefined {
  const paths = operands(args, valueFlags)
  const destination = paths.pop()
  return destination === undefined ? undefined : act(name, paths.length === 0 ? fileSubject(destination) : `${files(paths)} to ${fileSubject(destination)}`)
}

function tmux(args: readonly string[]): Clause | undefined {
  let i = 0
  while ((args[i] ?? "").startsWith("-")) i += ["-L", "-S", "-f"].includes(args[i] ?? "") ? 2 : 1
  const sub = args[i]
  const rest = args.slice(i + 1)
  const target = option(rest, ["-t"])
  const where = target === undefined ? "" : ` in ${target}`
  switch (sub) {
    case "send-keys": case "send": {
      const keys = operands(rest, ["-t", "-N"])
      const text = keys.filter((key) => !/^(?:Enter|C-[a-z]|Escape|Tab|BSpace|Up|Down|Left|Right|Space|PageUp|PageDown|M-[a-z])$/.test(key)).join(" ")
      return text === "" ? act("Pressed", `${keys.join(" ")}${where}`) : act("Typed", `${text}${where}`)
    }
    case "capture-pane": case "capturep": return look("Captured", `tmux pane${target === undefined ? "" : ` ${target}`}`)
    case "new-session": case "new": return act("Started", `tmux session${option(rest, ["-s"]) === undefined ? "" : ` ${option(rest, ["-s"])}`}`)
    case "kill-session": case "kill-server": case "kill-pane": return act("Stopped", `tmux session${target === undefined ? "" : ` ${target}`}`)
    case "has-session": case "list-sessions": case "ls": case "list-panes": case "display-message": return look("Checked", "tmux")
    default: return setup("Configured", "tmux")
  }
}

const BROWSER_FLAGS = ["--session", "--cdp", "--profile", "--executable-path", "--headers", "--proxy", "--user-agent", "--args", "--state", "--timeout"]

type Program = (args: readonly string[], command: ShellCommand) => Clause | undefined

function sqlite(args: readonly string[], command: ShellCommand): Clause {
  const [database = "", sql] = operands(args, ["-cmd", "-separator", "-newline", "-nullvalue", "-c"])
  return act("Queried", sqlTable(sql ?? option(args, ["-c"]) ?? command.stdin ?? "") ?? fileSubject(database))
}

function opened(args: readonly string[]): Clause {
  const target = operands(args, ["-a", "-b"])[0]
  return act("Opened", target === undefined ? option(args, ["-a"]) ?? "" : /^[a-z]+:\/\//i.test(target) ? displayUrl(target) : fileSubject(target))
}

function compared(args: readonly string[]): Clause {
  const [a = "", b = ""] = operands(args, ["-U", "--label", "-x", "--exclude"])
  return look("Compared", a.startsWith("<(") || b.startsWith("<(") ? "command output" : `${fileSubject(a)} with ${fileSubject(b)}`)
}

function browser(args: readonly string[]): Clause {
  const [sub = "", target] = operands(args, BROWSER_FLAGS)
  return act("Drove", `browser ${sub}${["open", "goto", "navigate"].includes(sub) && target !== undefined ? ` ${displayUrl(target)}` : ""}`)
}

function flywheel(args: readonly string[]): Clause | undefined {
  const words = operands(args, [])
  return words[0] === "events" && words[1] === "search" ? look("Searched", ["events", ...words.slice(2)].join(" ")) : undefined
}

function waited(args: readonly string[]): Clause {
  const [duration = ""] = operands(args, [])
  return setup("Waited", `${duration}${/^\d+(?:\.\d+)?$/.test(duration) ? "s" : ""}`)
}

const firstOperand = (args: readonly string[]) => operands(args, [])[0] ?? ""

/** Every program this module recognizes, by the name its command starts with. */
const PROGRAMS = new Map<string, Program>([
  ["git", git], ["gh", gh], ["dbt", dbt], ["tmux", tmux], ["agent-browser", browser], ["flywheel", flywheel],
  ...["pytest", "py.test"].map((name): [string, Program] => [name, (args) => tested("pytest", args)]),
  ...["vitest", "jest"].map((name): [string, Program] => [name, (args) => tested(name, args)]),
  ...["bun", "node", "deno", "tsx", "ts-node"].map((name): [string, Program] => [name, (args, command) => javascript(name, args, command)]),
  ...["npm", "pnpm", "yarn"].map((name): [string, Program] => [name, (args) => packageManager(name, args)]),
  ...["pip", "pip3", "brew", "gem"].map((name): [string, Program] => [name, (args) => INSTALL_WORDS.has(firstOperand(args)) ? installed(args) : undefined]),
  ["uv", (args) => ["sync", "add", "pip"].includes(firstOperand(args)) ? installed(args) : undefined],
  ["snow", (args, command) => args[0] === "sql" ? query("Snowflake", option(args, ["-f", "--filename"]), option(args, ["-q", "--query"]) ?? command.stdin) : undefined],
  ["psql", (args, command) => query("Postgres", option(args, ["-f", "--file"]), option(args, ["-c", "--command"]) ?? command.stdin)],
  ["sqlite3", sqlite], ["duckdb", sqlite],
  ["bq", (args, command) => args[0] === "query" ? query("BigQuery", undefined, operands(args.slice(1), [])[0] ?? command.stdin) : undefined],
  ...["curl", "wget", "xh", "http"].map((name): [string, Program] => [name, fetched]),
  ["open", opened], ["xdg-open", opened],
  ...["kill", "pkill", "killall"].map((name): [string, Program] => [name, (args) => act("Stopped", operands(args, ["-s", "-n"]).filter((arg) => !/^-?\d*[A-Z]+$/.test(arg)).join(", "))]),
  ...["ps", "pgrep", "lsof", "top"].map((name): [string, Program] => [name, () => look("Checked", "processes")]),
  ["df", () => look("Checked", "disk space")],
  ["direnv", (args) => args[0] === "allow" ? setup("Allowed", "direnv") : undefined],
  ...["which", "where", "type", "command"].map((name): [string, Program] => [name, (args) => setup("Located", operands(args, []).join(", "))]),
  ["sleep", waited],
  ...["mkdir", "touch"].map((name): [string, Program] => [name, (args) => setup("Created", files(operands(args, ["-m"])))]),
  ...["chmod", "chown"].map((name): [string, Program] => [name, (args) => setup("Changed", `mode of ${files(operands(args, []).slice(1))}`)]),
  ["ln", (args) => setup("Linked", fileSubject(operands(args, []).at(-1) ?? ""))],
  ...["cp", "scp", "rsync"].map((name): [string, Program] => [name, (args) => moved("Copied", args, ["-e", "--exclude", "--include", "-t", "--target-directory", "-P"])]),
  ["mv", (args) => moved("Moved", args, ["-t", "--target-directory"])],
  ...["rm", "rmdir", "unlink", "trash"].map((name): [string, Program] => [name, (args) => act("Removed", files(operands(args, [])) || "files")]),
  ...["diff", "cmp", "comm"].map((name): [string, Program] => [name, compared]),
  ...["shasum", "sha256sum", "sha1sum", "md5", "md5sum", "cksum", "b3sum"].map((name): [string, Program] => [name, (args) => look("Hashed", files(operands(args, ["-a"])))]),
  ...["stat", "file"].map((name): [string, Program] => [name, (args) => look("Inspected", files(operands(args, ["-f", "-c", "--format"])))]),
  ["xcrun", (args) => args[0] === "simctl" ? act("Drove", `simulator ${args[1] ?? ""}`.trim()) : undefined],
])

/** The clause of a program this module recognizes, or nothing so the caller presents the command as itself. */
export function programClause(head: string, args: readonly string[], command: ShellCommand): Clause | undefined {
  const program = PROGRAMS.get(head)
  if (program !== undefined) return program(args, command)
  if (PYTHON.test(head)) return python(args, command)
  return CHECKERS.has(head) ? checked(head, args) : undefined
}
