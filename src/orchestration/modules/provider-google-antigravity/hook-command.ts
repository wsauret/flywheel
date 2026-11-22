import { GATE_HOOK_TIMEOUT_SECONDS } from "../../../infra/antigravity-gate-hook.js"
import { executableRoleCommand } from "../../../infra/cli-subprocess.js"
import { EXECUTABLE_ROLES } from "../../../infra/executable-roles.js"

/** One handler of a `hooks.json` event, in the engine's documented form: a
 *  single shell command string and a timeout in seconds. */
export interface GateHookHandler {
  readonly type: "command"
  readonly command: string
  readonly timeout: number
}

/** The PreInvocation handler that runs this executable's gate hook client
 *  (ARCH-PROVIDERS-087) against the step gate at `address` for one login.
 *  `entry` is the argv that starts the client role, by default the running
 *  executable's own form for an installed or a source run. The command is
 *  quoted for the shell the engine runs hooks in on `platform`. Throws when the
 *  Windows form would hold text that `cmd.exe` changes or cannot carry. */
export function gateHookHandler(options: {
  readonly address: string
  readonly loginGateId: string
  readonly entry?: readonly string[]
  readonly platform?: NodeJS.Platform
}): GateHookHandler {
  const argv = [...options.entry ?? executableRoleCommand(EXECUTABLE_ROLES.antigravityGate), options.address, options.loginGateId]
  const command = (options.platform ?? process.platform) === "win32" ? windowsCommand(argv) : argv.map(posixWord).join(" ")
  return { type: "command", command, timeout: GATE_HOOK_TIMEOUT_SECONDS }
}

const POSIX_PLAIN = /^[\w@%+=:,./-]+$/

/** One `sh` word: plain when it has no shell syntax, otherwise single-quoted,
 *  where only a single quote needs an escape. */
function posixWord(argument: string): string {
  return POSIX_PLAIN.test(argument) ? argument : `'${argument.replaceAll("'", `'\\''`)}'`
}

const WINDOWS_PLAIN = /^[^\s&|<>()^]+$/
// The engine runs a hook as `cmd /s /c "<command>"`, which removes only the
// outer quote pair, so every quote inside the command keeps its meaning. A
// quoted word cannot carry a double quote or a line break.
const WINDOWS_UNQUOTABLE = /["\r\n]/
// `cmd` expands `%NAME%` inside quotes, and `!NAME!` when the registry turns
// on delayed expansion; a lone `%` or `!` stays literal. Expansion reads the
// whole line, so a `%` of one word can pair with a `%` of the next.
const WINDOWS_EXPANSION = /%[^%]+%|![^!]+!/

/** The words for `cmd.exe`, each plain when it needs no quotes, otherwise
 *  quoted. Backslashes that end a quoted word are doubled so they do not
 *  escape its closing quote. */
function windowsCommand(argv: readonly string[]): string {
  const unquotable = argv.find((argument) => WINDOWS_UNQUOTABLE.test(argument))
  if (unquotable !== undefined) throw new Error(`a Windows hook command cannot carry the argument ${JSON.stringify(unquotable)}`)
  const command = argv.map((argument) => (WINDOWS_PLAIN.test(argument) ? argument : `"${argument.replace(/\\+$/, "$&$&")}"`)).join(" ")
  const expansion = WINDOWS_EXPANSION.exec(command)
  if (expansion) throw new Error(`a Windows hook command cannot carry ${JSON.stringify(expansion[0])}, which cmd.exe expands`)
  return command
}
