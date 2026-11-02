import { isAbsolute } from "node:path"

import { runInheritedCommand } from "../../../infra/inherited-command.js"
import { splitGitAlias } from "./bash-git-alias.js"
import { classifyGitArgv, GIT_MUTATION_REFUSAL } from "./bash-git-policy.js"

type MutationGitResult =
  | { readonly kind: "refused"; readonly exitCode: 97; readonly message: string }
  | { readonly kind: "delegated"; readonly exitCode: number; readonly signalCode: NodeJS.Signals | null }

const TRUSTED_READ_OPTIONS = ["--no-optional-locks", "-c", "core.fsmonitor=false"]
const CONFIG_PATTERN = "^(alias\\.|diff\\..*\\.textconv$)"

/** Applies mutation Git policy to argv without its executable. realGit is the
 * absolute executable captured before PATH is wrapped. Probes and delegation
 * inherit the helper's cwd, environment, and existing command container.
 * Refused commands are never delegated. Probe or launch failures reject.
 * No command or configuration content is logged. */
export async function runMutationGit(
  argv: readonly string[],
  realGit: string,
  run: typeof runInheritedCommand = runInheritedCommand,
): Promise<MutationGitResult> {
  const refused = { kind: "refused", exitCode: 97, message: GIT_MUTATION_REFUSAL } as const
  if (!isAbsolute(realGit)) return refused
  const visited = new Set<string>()
  let expanded = argv
  while (true) {
    const policy = classifyGitArgv(expanded)
    if (policy.kind === "refused" && policy.reason !== "unknown-command") return refused
    const command = policy.commandArgv[0]
    if (command === undefined) return refused
    const context = [...policy.contextArgv, ...TRUSTED_READ_OPTIONS]
    const drivers = new Set<string>()
    // Version/help flags do not read repository configuration in Git.
    if (!command.startsWith("-")) {
      const config = await run([realGit, ...context, "config", "--null", "--get-regexp", CONFIG_PATTERN], {
        output: "capture", stdin: "ignore",
      })
      if (config.signalCode !== null || config.stdoutTruncated || config.stderrTruncated || (config.exitCode !== 0 && config.exitCode !== 1)) return refused
      const aliases = new Map<string, string>()
      for (const record of config.stdout.split("\0")) {
        if (record === "") continue
        const newline = record.indexOf("\n")
        const key = newline < 0 ? record : record.slice(0, newline)
        const value = newline < 0 ? "" : record.slice(newline + 1)
        if (key.startsWith("alias.")) aliases.set(key.slice(6).toLowerCase(), value)
        if (key.startsWith("diff.") && key.endsWith(".textconv")) {
          drivers.add(key.slice(0, -9))
        }
      }
      if (policy.kind === "refused") {
        const name = command.toLowerCase()
        if (visited.has(name)) return refused
        const alias = aliases.get(name)
        if (alias === undefined || alias.startsWith("!")) return refused
        // Git builtins win even when the policy has not certified their mode.
        const builtins = await run([realGit, ...context, "--list-cmds=builtins"], { output: "capture", stdin: "ignore" })
        if (builtins.exitCode !== 0 || builtins.signalCode !== null || builtins.stdoutTruncated || builtins.stdout.split("\n").includes(command)) return refused
        const aliasArgv = splitGitAlias(alias)
        if (aliasArgv === undefined || aliasArgv[0] === "") return refused
        visited.add(name)
        expanded = [...policy.contextArgv, ...aliasArgv, ...policy.commandArgv.slice(1)]
        continue
      }
    }
    const overrides = [...drivers].flatMap((driver) => ["-c", `${driver}.cachetextconv=false`])
    const exit = await run([realGit, ...context, ...overrides, ...policy.commandArgv], { output: "inherit" })
    return { kind: "delegated", exitCode: exit.exitCode, signalCode: exit.signalCode }
  }
}

/** Hidden executable role for the native and POSIX PATH forwarders.
 * FLYWHEEL_MUTATION_GIT_REAL holds the captured absolute Git executable.
 * Runtime/source selection belongs to the forwarder, never PATH resolution.
 * Every failure emits the fixed refusal sentence without command content. */
export async function runMutationGitMain(): Promise<void> {
  try {
    const delimiter = process.argv.indexOf("--")
    const result = await runMutationGit(delimiter < 0 ? [] : process.argv.slice(delimiter + 1), process.env.FLYWHEEL_MUTATION_GIT_REAL ?? "")
    if (result.kind === "refused") process.stderr.write(`${result.message}\n`)
    else if (result.signalCode !== null) process.kill(process.pid, result.signalCode)
    process.exitCode = result.exitCode
  } catch {
    process.stderr.write(`${GIT_MUTATION_REFUSAL}\n`)
    process.exitCode = 97
  }
}
