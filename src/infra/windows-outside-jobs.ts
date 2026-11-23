import { existsSync } from "node:fs"
import { win32 } from "node:path"

import { Log } from "./log.js"
import { trustedCommandRun, type TrustedCommandResult, type TrustedProbeLaunch } from "./process-container.js"
import { windowsProcessApi, type WindowsProcessHold } from "./windows-process-api.js"

/** A process that WMI starts outside every job of this process.
 *
 *  Windows lets a process leave its job only when the job allows it, and an
 *  editor that holds each agent in a kill-on-close job ends every process that
 *  the agent started with it. WMI `Win32_Process.Create` starts the process
 *  from the WMI service instead, so it is in none of this process's jobs.
 *
 *  WMI gives the process no standard handles. So WMI starts the system
 *  `cmd.exe`, which opens the two output files and runs the command with its
 *  output and error output in them, before any of the command's own code runs.
 *  An error that the command writes before it can say anything else, such as
 *  the launcher's, is then in the error file, where the launcher reads it.
 *
 *  The process is created suspended and resumes only after this process holds
 *  it and proved that the pid that WMI answered names the process that WMI
 *  created. A launch that fails before then leaves no process that ran, so no
 *  process that writes the output files. */

const log = Log.create({ service: "windows-outside-jobs" })

/** What a launch outside every job runs, and where its output goes. */
export interface OutsideJobsLaunchRequest {
  readonly command: readonly string[]
  readonly cwd: string | undefined
  /** The whole environment of the process, or this process's when absent. */
  readonly env: { readonly [name: string]: string | undefined } | undefined
  readonly stdoutPath: string
  readonly stderrPath: string
}

/** A process that a launch outside every job started and holds. */
export interface OutsideJobsChild {
  readonly pid: number
  /** Settles with the exit code while this process watches the child, which
   *  is until `unref`. */
  readonly exited: Promise<number>
  readonly kill: () => void
  /** Stops watching the child and closes the hold on it. `exited` settles
   *  only when the child had already ended. */
  unref(): void
}

/** The step at which a launch outside every job stopped. */
type OutsideJobsStage =
  | "create"
  | "argument"
  | "system-directory"
  | "powershell"
  | "wmi"
  | "hold"
  | "identity"
  | "resume"

/** A launch outside every job that did not start the process, with the step
 *  and a reason that holds no output of the helper and no value of the
 *  request. Nothing starts the process another way: a process left in the
 *  launcher's job would end with the host that holds that job. */
export class OutsideJobsLaunchError extends Error {
  readonly stage: OutsideJobsStage

  constructor(stage: OutsideJobsStage, reason: string) {
    super(`Windows did not start the process outside the jobs of this process: ${reason}`)
    this.name = "OutsideJobsLaunchError"
    this.stage = stage
  }
}

/** What a launch outside every job needs from Windows, replaceable so the
 *  launch can be tested on any host. */
export interface OutsideJobsSeams {
  readonly systemDirectory: () => string | undefined
  readonly exists: (path: string) => boolean
  /** Runs one trusted command with `input` as its standard input, as
   *  `trustedCommandRun` does. */
  readonly run: (launch: TrustedProbeLaunch, input: string) => Promise<TrustedCommandResult>
  readonly hold: (pid: number) => WindowsProcessHold | undefined
  /** How often a held process is checked for its exit. */
  readonly pollMs: number
}

/** `Win32_ProcessStartup.CreateFlags`: `CREATE_SUSPENDED` and
 *  `CREATE_NEW_CONSOLE`. The new console is hidden, because the startup
 *  shows no window, and every console program of the command shares it, so
 *  none of them makes a console window of its own. */
const OUTSIDE_JOBS_CREATE_FLAGS = 0x4 | 0x10
/** The documented failure answers of `Win32_Process.Create`. */
const WMI_CREATE_ANSWERS = new Map([[2, "access denied"], [3, "insufficient privilege"], [8, "unknown failure"], [9, "path not found"], [21, "invalid parameter"]])
/** A cold PowerShell start prepares its runtime first, which can take
 *  seconds on a loaded host. */
const WMI_CREATE_TIMEOUT_MS = 30_000
export const OUTSIDE_JOBS_POLL_MS = 100
/** The exit codes the script chooses: it failed before WMI created the
 *  process, or after. */
const SCRIPT_NOT_CREATED = 2
const SCRIPT_CREATED = 3
const VARIABLE_PREFIX = "FLYWHEEL_OUTSIDE_JOBS_"

/** The script reads its request as base64 JSON on standard input, so no
 *  value passes through a command line, and no code page can change a
 *  character. It calls .NET methods only and no command: PowerShell module
 *  logging records the values bound to command parameters, and the request
 *  holds the environment, secrets included. So it also loads no module. A
 *  local WMI create keeps the caller's session, so the process runs on the
 *  person's desktop as one the launcher started would. */
const WMI_CREATE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$created = $false",
  "try {",
  "  [void][Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')",
  "  $json = [Web.Script.Serialization.JavaScriptSerializer]::new()",
  "  $json.MaxJsonLength = [int]::MaxValue",
  "  $request = $json.DeserializeObject([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())))",
  "  $startup = ([Management.ManagementClass]'Win32_ProcessStartup').CreateInstance()",
  "  $startup['ShowWindow'] = [uint16]0",
  "  $startup['CreateFlags'] = [uint32]$request['createFlags']",
  "  $startup['EnvironmentVariables'] = [string[]]$request['environment']",
  "  $class = [Management.ManagementClass]'Win32_Process'",
  "  $parameters = $class.GetMethodParameters('Create')",
  "  $parameters['CommandLine'] = [string]$request['commandLine']",
  "  $parameters['CurrentDirectory'] = [string]$request['cwd']",
  "  $parameters['ProcessStartupInformation'] = $startup",
  "  $answer = $class.InvokeMethod('Create', $parameters, $null)",
  "  $returnValue = [int]$answer['ReturnValue']",
  "  $created = $returnValue -eq 0",
  "  $reply = @{ returnValue = $returnValue }",
  "  if ($created) {",
  "    $processId = [int]$answer['ProcessId']",
  "    $reply['processId'] = $processId",
  "    $reply['creationDate'] = [string]([Management.ManagementObject]\"Win32_Process.Handle='$processId'\")['CreationDate']",
  "  }",
  "  [Console]::Out.Write($json.Serialize($reply))",
  "} catch {",
  `  if ($created) { exit ${SCRIPT_CREATED} }`,
  `  exit ${SCRIPT_NOT_CREATED}`,
  "}",
].join("\n")
const ENCODED_WMI_CREATE_SCRIPT = Buffer.from(WMI_CREATE_SCRIPT, "utf16le").toString("base64")

const OUTSIDE_JOBS_SEAMS: OutsideJobsSeams = {
  systemDirectory: () => windowsProcessApi()?.systemDirectory(),
  exists: existsSync,
  run: (launch, input) => trustedCommandRun(launch, launch.timeoutMs, input),
  hold: (pid) => windowsProcessApi()?.hold(pid),
  pollMs: OUTSIDE_JOBS_POLL_MS,
}

/** The PowerShell launch of the script. Its program and its module path are
 *  in the system directory, so no directory that the user can write supplies
 *  code to it. */
function scriptLaunch(systemDirectory: string, powershell: string): TrustedProbeLaunch {
  return {
    argv: [powershell, "-NoProfile", "-NonInteractive", "-NoLogo", "-EncodedCommand", ENCODED_WMI_CREATE_SCRIPT],
    env: { SystemRoot: win32.dirname(systemDirectory), PATH: systemDirectory, PSModulePath: win32.join(systemDirectory, "WindowsPowerShell", "v1.0", "Modules") },
    timeoutMs: WMI_CREATE_TIMEOUT_MS,
    windowsHide: true,
  }
}

/** A `cmd.exe` command line and the variables, by name and value, that it
 *  reads its values from. */
interface CmdLaunch {
  readonly commandLine: string
  readonly variables: readonly (readonly [string, string])[]
}

/** The `cmd.exe` command line that runs `command` with its output in the two
 *  files, and the variables it reads them from.
 *
 *  Each value reaches the line as a quoted `%NAME%` reference. `cmd` expands
 *  a reference once and never expands or interprets its value again inside
 *  quotes, so a `%`, `^`, `&`, or space in a path or argument stays literal.
 *  Only a quote or a line break could end the quoted value, so an argument
 *  with one is refused. An empty argument is written as `""`, because `cmd`
 *  leaves the reference of an empty variable unexpanded. The line clears
 *  every variable before the command runs: `cmd` expands the whole line
 *  first, so the command gets exactly the environment it was given. */
function cmdLaunch(systemDirectory: string, request: OutsideJobsLaunchRequest): CmdLaunch {
  const variables: (readonly [string, string])[] = []
  const reference = (name: string, value: string): string => {
    variables.push([`${VARIABLE_PREFIX}${name}`, value])
    return `"%${VARIABLE_PREFIX}${name}%"`
  }
  const words = request.command.map((argument, index) => {
    if (/["\r\n\0]/u.test(argument)) throw new OutsideJobsLaunchError("argument", `argument ${index} holds a quote or a line break, which cmd.exe cannot pass on`)
    if (argument === "") return '""'
    // The C runtime reads backslashes before a closing quote as escapes, so
    // the trailing ones double. The program name is read without escapes.
    return reference(`ARG${index}`, index === 0 ? argument : argument.replace(/(\\+)$/u, "$1$1"))
  })
  const stdout = reference("STDOUT", request.stdoutPath)
  const stderr = reference("STDERR", request.stderrPath)
  const clear = variables.map(([name]) => `set "${name}="`).join(" & ")
  return {
    commandLine: `"${win32.join(systemDirectory, "cmd.exe")}" /d /v:off /s /c "${clear} & ${words.join(" ")} <nul 1>>${stdout} 2>>${stderr}"`,
    variables,
  }
}

/** The answer of the script, or nothing when it is not one. */
function decodeReply(stdout: string):
  | { readonly kind: "refused"; readonly returnValue: number }
  | { readonly kind: "created"; readonly processId: number; readonly creationDate: string }
  | undefined {
  let reply: unknown
  try {
    reply = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (typeof reply !== "object" || reply === null || !("returnValue" in reply) || !Number.isInteger(reply.returnValue)) return undefined
  const returnValue = Number(reply.returnValue)
  if (returnValue !== 0) return { kind: "refused", returnValue }
  if (!("processId" in reply) || !Number.isInteger(reply.processId) || !("creationDate" in reply) || typeof reply.creationDate !== "string") return undefined
  return { kind: "created", processId: Number(reply.processId), creationDate: reply.creationDate }
}

const FILETIME_EPOCH_MS = 11_644_473_600_000n

/** A CIM datetime, `yyyymmddHHMMSS.ffffff` and the offset from UTC in
 *  minutes, as microseconds since the FILETIME epoch: the precision WMI
 *  states a creation time in. */
function cimDatetimeMicros(text: string): bigint | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/u.exec(text)
  if (match === null) return undefined
  const field = (index: number): number => Number(match[index])
  const localMs = Date.UTC(field(1), field(2) - 1, field(3), field(4), field(5), field(6))
  const offsetMs = (match[8] === "-" ? -1 : 1) * field(9) * 60_000
  return (BigInt(localMs - offsetMs) + FILETIME_EPOCH_MS) * 1_000n + BigInt(field(7))
}

/** Starts `request.command` outside every job of this process through WMI,
 *  with its output and error output appended to `request.stdoutPath` and
 *  `request.stderrPath`, and holds it. The pid is that of the `cmd.exe` that
 *  runs the command, which ends with the command's exit code. The process
 *  gets exactly `request.env`, as a spawn would, and this process's working
 *  directory when `request.cwd` names none. Throws `OutsideJobsLaunchError`
 *  when no process was started, and then no process wrote the files. */
export async function launchOutsideJobs(request: OutsideJobsLaunchRequest, seams: OutsideJobsSeams = OUTSIDE_JOBS_SEAMS): Promise<OutsideJobsChild> {
  try {
    const child = await startOutsideJobs(request, seams)
    log.info("a process started outside every job", { pid: child.pid, path: "wmi" })
    return child
  } catch (error) {
    if (error instanceof OutsideJobsLaunchError) log.warn("a process could not start outside every job", { stage: error.stage, path: "wmi", outcome: "refused" })
    throw error
  }
}

async function startOutsideJobs(request: OutsideJobsLaunchRequest, seams: OutsideJobsSeams): Promise<OutsideJobsChild> {
  const systemDirectory = seams.systemDirectory()
  if (systemDirectory === undefined) throw new OutsideJobsLaunchError("system-directory", "the kernel did not name the system directory")
  const { commandLine, variables } = cmdLaunch(systemDirectory, request)
  const powershell = win32.join(systemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe")
  if (!seams.exists(powershell)) throw new OutsideJobsLaunchError("powershell", `${powershell} does not exist`)
  const environment = [
    ...Object.entries(request.env ?? process.env).flatMap(([name, value]) => value === undefined ? [] : [`${name}=${value}`]),
    ...variables.map(([name, value]) => `${name}=${value}`),
  ]
  const input = Buffer.from(JSON.stringify({ commandLine, cwd: request.cwd ?? process.cwd(), environment, createFlags: OUTSIDE_JOBS_CREATE_FLAGS })).toString("base64")
  // The script's error output is never read into a reason: it can quote the
  // request, and the request holds the environment.
  let answer: TrustedCommandResult
  try {
    answer = await seams.run(scriptLaunch(systemDirectory, powershell), input)
  } catch {
    throw new OutsideJobsLaunchError("powershell", "the answer of PowerShell could not be read")
  }
  if (answer.exitCode === null) throw new OutsideJobsLaunchError("powershell", `PowerShell did not start, or did not answer within ${WMI_CREATE_TIMEOUT_MS / 1_000} seconds`)
  if (answer.exitCode === SCRIPT_NOT_CREATED) throw new OutsideJobsLaunchError("wmi", "PowerShell could not ask WMI to create the process")
  const reply = answer.exitCode === 0 ? decodeReply(answer.stdout) : undefined
  if (reply === undefined) throw new OutsideJobsLaunchError("wmi", `PowerShell did not report the process it created (exit code ${answer.exitCode})`)
  if (reply.kind === "refused") throw new OutsideJobsLaunchError("wmi", `WMI Win32_Process.Create answered ${reply.returnValue} (${WMI_CREATE_ANSWERS.get(reply.returnValue) ?? "an undocumented answer"})`)
  const pid = reply.processId
  const created = cimDatetimeMicros(reply.creationDate)
  const hold = seams.hold(pid)
  if (hold === undefined) throw new OutsideJobsLaunchError("hold", `the process that WMI created, pid ${pid}, could not be opened`)
  // A FILETIME counts 100 ns; WMI states the same time to the microsecond.
  if (created === undefined || hold.createdFileTime / 10n !== created) {
    hold.close()
    throw new OutsideJobsLaunchError("identity", `pid ${pid} does not hold the process that WMI created, so nothing was signalled`)
  }
  if (!hold.resume()) {
    hold.terminate()
    hold.close()
    throw new OutsideJobsLaunchError("resume", `the process that WMI created, pid ${pid}, could not be resumed`)
  }
  return watchHeldProcess(pid, hold, seams.pollMs)
}

/** Reads the exit of the held process every `pollMs`, and closes the hold
 *  once it ended or the launcher gives the process up. */
export function watchHeldProcess(pid: number, hold: WindowsProcessHold, pollMs: number): OutsideJobsChild {
  const ended = Promise.withResolvers<number>()
  const check = (): boolean => {
    const code = hold.exitCode()
    if (code === undefined) return false
    clearInterval(timer)
    hold.close()
    ended.resolve(code)
    return true
  }
  const timer = setInterval(check, pollMs)
  return {
    pid,
    exited: ended.promise,
    kill: () => { hold.terminate() },
    // An exit that happened since the last check still settles `exited`,
    // so a launcher that gives the process up as it ends sees that end.
    unref: () => {
      if (check()) return
      clearInterval(timer)
      hold.close()
    },
  }
}
