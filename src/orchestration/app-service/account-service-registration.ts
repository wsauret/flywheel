import { createHash } from "node:crypto"

import { Schema } from "effect"

import type { ServeLane } from "../../infra/cli-subprocess.js"

/** The texts the service managers register for the account service, one per
 *  platform, and the fingerprint each one carries of itself.
 *
 *  Every registration states one contract (ARCH-RUNTIME-021, ARCH-RUNTIME-041). The service runs at
 *  normal interactive scheduling, no manager stops it for elapsed time or
 *  battery state, and a stop waits longer than the service's own drain bound.
 *  Exit 0 parks the job: another owner serves, or the service's starts have
 *  failed long enough that a restart would only fail again. Any other exit
 *  restarts it where the manager can. Flywheel ends its own process tree, so
 *  a manager ends only the service process and never its descendants. The
 *  standard error of a start stays readable where the manager can keep it:
 *  launchd appends it to a file that the registration names, and systemd
 *  keeps it in the journal. Task Scheduler keeps none.
 *
 *  The launchd job and the scheduled task carry a fingerprint, a hash of the
 *  registration's own text. launchd passes it to the service in its
 *  environment, so a service knows which registration started it; the task
 *  states it in its description, where a query reads it back. The systemd
 *  unit needs none: systemd itself says when its loaded unit differs from
 *  the file (NeedDaemonReload). */

/** The names one lane's registration holds in each service manager. Each
 *  lane registers its own job, so the installed and the dev service stand
 *  side by side (ARCH-RUNTIME-008). `reloadHelper` is the label of the
 *  transient launchd job that re-registers the service. */
export interface ServiceNames {
  readonly launchd: string
  readonly reloadHelper: string
  readonly systemdUnit: string
  readonly windowsTask: string
}

export const SERVICE_NAMES = {
  installed: { launchd: "sh.flywl.flywheel.serve", reloadHelper: "sh.flywl.flywheel.serve.reload", systemdUnit: "flywheel-serve.service", windowsTask: "Flywheel Serve" },
  dev: { launchd: "sh.flywl.flywheel.serve-dev", reloadHelper: "sh.flywl.flywheel.serve-dev.reload", systemdUnit: "flywheel-serve-dev.service", windowsTask: "Flywheel Serve Dev" },
} as const satisfies { readonly [Lane in ServeLane]: ServiceNames }
/** What a service manager runs, with `serve` and its arguments after it: the
 *  lane's program and the arguments that lead every Flywheel command. */
export type ServiceCommand = readonly [program: string, ...leading: string[]]

export const REGISTRATION_FINGERPRINT_ENV = "FLYWHEEL_SERVICE_REGISTRATION"
/** The argument the scheduled task passes to `serve`, which says that Task
 *  Scheduler started the service. Task Scheduler passes the action no
 *  environment, and the Schedule service that starts it names no task, so an
 *  argument of the task's own definition is the only start marker it has.
 *  A task that a release before 2026-09-23 registered passes none: every
 *  update runs `serve install`, which recreates that task because its
 *  fingerprint differs, and until then its service is resident only in a
 *  proven login home. Remove this note after 2027-03-23. */
export const SCHEDULED_TASK_ARGUMENT = "--scheduled-task"

/** The loop guard's record of the one launchd reload attempted for the
 *  registration fingerprint on disk. Each outcome says how far that reload
 *  got:
 *  - `proven`: the build tick proved the login home before the service
 *    requested its own replacement, so the stale start that follows asks
 *    nothing and hands the reload off.
 *  - `requested`: a stale start handed the reload off to the helper job.
 *    Only this record lets a helper that is still loaded park a start.
 *  - `reloaded` and `failed`: what the helper did. The reload is over, and a
 *    stale start serves as it is.
 *  A build before `proven` reads that record as a shape it does not know,
 *  warns, and ignores it, so a rollback only asks the login home again. */
export const RegistrationReloadRecordSchema = Schema.Struct({
  fingerprint: Schema.String,
  outcome: Schema.Literals(["proven", "requested", "reloaded", "failed"]),
  error: Schema.optionalKey(Schema.String),
})
export type RegistrationReloadRecord = typeof RegistrationReloadRecordSchema.Type

/** How long a manager waits for the service to stop before it kills it. It
 *  is above the account's drain bound (ACCOUNT_DRAIN_HARD_EXIT_MS), so the
 *  drain always ends first. 60 seconds is the largest value launchd accepts
 *  in the gui domain. */
export const SERVICE_STOP_TIMEOUT_SECONDS = 60

/** How long launchd waits after a start before it starts the job again. Its
 *  default, 10 seconds, applies to every restart of an instance that ran
 *  less than that, such as a service that `flywheel kill` ends right after
 *  an install started it, and a client's start request blocks until it
 *  passes. The service owns its crash-loop policy: a failing streak parks the
 *  job and a build that cannot listen rolls back, so launchd only spaces the
 *  starts. Measured on macOS 26: a job killed 0.3 seconds after its start
 *  restarts after 9.1 seconds by default and after 1.1 seconds with 1. */
const LAUNCHD_RESTART_SPACING_SECONDS = 1

const FINGERPRINT_PATTERN = new RegExp(`${REGISTRATION_FINGERPRINT_ENV}(?:</key>\\s*<string>|=)([0-9a-f]{16})`)

/** The fingerprint a registration text carries, or undefined for a text that
 *  carries none. A registration that an earlier release wrote carries none,
 *  so it never equals the current one and is replaced once. `schtasks /Query
 *  /XML` can answer in UTF-16 read as bytes, with a leading byte-order mark
 *  and a NUL beside every character, so both are removed first, as OpenClaw
 *  reads the same query. */
export function registrationFingerprint(text: string | undefined): string | undefined {
  return text === undefined ? undefined : FINGERPRINT_PATTERN.exec(text.replace(/^\uFEFF/u, "").replaceAll("\0", ""))?.[1]
}

/** Renders a registration with the fingerprint of its own text. */
function fingerprinted(render: (fingerprint: string) => string): string {
  return render(createHash("sha256").update(render("")).digest("hex").slice(0, 16))
}

const escapeXml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** The LaunchAgent. ProcessType Interactive keeps the whole service tree out
 *  of the darwin background band, which a process cannot leave by itself.
 *  KeepAlive restarts a service that exits non-zero or on a signal and parks
 *  one that exits 0, and ThrottleInterval spaces those restarts by
 *  LAUNCHD_RESTART_SPACING_SECONDS. StandardErrorPath names `errorLog`, where
 *  launchd appends the standard error of every start. It keeps the output of
 *  a start that fails before the account log can hold its cause, such as a
 *  crash in native code, and each start keeps the file bounded. Without `errorLog` the
 *  registration names no file, and launchd discards that output.
 *
 *  No key sets an open-file limit. launchd starts a user agent with a soft
 *  limit of 256 and no hard limit, but the service's runtime raises its own
 *  soft limit when it starts, to its hard limit with a maximum of 1048576, and
 *  every process it launches inherits the raised limit.
 *  `service-open-file-limit.test.ts` pins that dependency. */
export function launchdPlist(label: string, program: readonly string[], accountHome: string, errorLog: string | undefined): string {
  const args = program.map((arg) => `    <string>${escapeXml(arg)}</string>`).join("\n")
  return fingerprinted((fingerprint) => [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${escapeXml(label)}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    args,
    `  </array>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${escapeXml(accountHome)}</string>`,
    ...(errorLog === undefined ? [] : [`  <key>StandardErrorPath</key>`, `  <string>${escapeXml(errorLog)}</string>`]),
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    `    <key>${REGISTRATION_FINGERPRINT_ENV}</key>`,
    `    <string>${fingerprint}</string>`,
    `  </dict>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <dict>`,
    `    <key>SuccessfulExit</key>`,
    `    <false/>`,
    `  </dict>`,
    `  <key>ProcessType</key>`,
    `  <string>Interactive</string>`,
    `  <key>ExitTimeOut</key>`,
    `  <integer>${SERVICE_STOP_TIMEOUT_SECONDS}</integer>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>${LAUNCHD_RESTART_SPACING_SECONDS}</integer>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n"))
}

/** The systemd user unit. Exit 75 is the service's retirement for a newer
 *  build or a stop by a signal: it counts as a success, so the unit never
 *  reads as failed, and it forces a restart. A stop that systemd itself
 *  performs restarts nothing. KillMode=process ends only the service process
 *  on a stop: its command supervisors end guarded work when their control
 *  channel closes, its guardian sweeps the rest, and persistent processes
 *  (ARCH-TOOLS-047) are released on purpose. A control-group kill would end that
 *  persistent work and kill executors in the middle of their drain.
 *  OOMPolicy=continue keeps the unit running when the kernel's OOM killer
 *  ends one of its processes. The default policy stops the whole unit and
 *  marks it failed, so one tool command that ran out of memory would cut the
 *  running work of every session. Each process's own owner handles its death
 *  instead. */
export function systemdUnit(command: ServiceCommand, accountHome: string): string {
  const quote = (arg: string) => `"${arg.replace(/(["\\])/g, "\\$1")}"`
  return [
    `[Unit]`,
    `Description=Flywheel account service`,
    `After=network-online.target`,
    ``,
    `[Service]`,
    `ExecStart=${command.map(quote).join(" ")} serve`,
    `WorkingDirectory=${accountHome}`,
    `Restart=on-failure`,
    `RestartSec=5`,
    `SuccessExitStatus=75`,
    `RestartForceExitStatus=75 SIGTERM SIGINT SIGHUP`,
    `TimeoutStopSec=${SERVICE_STOP_TIMEOUT_SECONDS}`,
    `KillMode=process`,
    `OOMPolicy=continue`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
    ``,
  ].join("\n")
}

/** The scheduled task, copied from OpenClaw's task XML and created from XML
 *  because `schtasks /Create` without it sets a 72 hour execution limit,
 *  battery conditions, and a below-normal priority that every child
 *  inherits. Task Scheduler passes no environment to its action, so the
 *  fingerprint lives in the description, where a query of the registered
 *  task reads it back, and the action passes SCHEDULED_TASK_ARGUMENT, which
 *  tells the service that Task Scheduler started it.
 *
 *  `sid` is the registering process's account SID. SSH sets USERDOMAIN to
 *  WORKGROUP while Task Scheduler sets it to the computer name, so an
 *  environment-built account name changed the fingerprint between contexts.
 *  The SID keeps the principal and logon trigger stable. The descriptor
 *  grants that account full access: an elevated registration otherwise
 *  leaves it only read access, which blocks later unelevated updates.
 *
 *  RestartOnFailure covers a start that fails. Whether Task Scheduler also
 *  restarts a task whose program exits with a code other than 0 is not
 *  proven on a Windows host, so nothing relies on it: the successor of a
 *  retired service starts at the next client start request or at logon. */
export function windowsTaskXml(command: ServiceCommand, sid: string): string {
  const [executable, ...leading] = command
  // Windows splits an action's arguments at spaces outside double quotes.
  const args = [...leading.map((arg) => /[\s"]/.test(arg) ? `"${arg.replaceAll("\"", "\\\"")}"` : arg), "serve", SCHEDULED_TASK_ARGUMENT].join(" ")
  return fingerprinted((fingerprint) => `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Flywheel account service. ${REGISTRATION_FINGERPRINT_ENV}=${fingerprint}</Description>
    <SecurityDescriptor>D:(A;;FA;;;${escapeXml(sid)})</SecurityDescriptor>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXml(sid)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(sid)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>255</Count>
    </RestartOnFailure>
    <Priority>4</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(executable)}</Command>
      <Arguments>${escapeXml(args)}</Arguments>
    </Exec>
  </Actions>
</Task>`)
}

/** Task Scheduler reads a task definition file as UTF-16LE with a byte-order
 *  mark on every locale. */
export function windowsTaskXmlBytes(xml: string): Uint8Array {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")])
}
