/** The fake service platform and manager answers that the account service
 *  installation tests and the registration control tests share, and the
 *  installation fake the tests of its callers share. */
import { expect } from "bun:test"

import { accountServiceRegistrationControl, createAccountServiceInstallation, type AccountServiceInstallation, type AccountServicePlatform } from "../../../../src/orchestration/app-service/account-service-installation.js"
import { systemdUnitPath } from "../../../../src/orchestration/app-service/account-service-systemd.js"
import { SERVICE_NAMES } from "../../../../src/orchestration/app-service/account-service-registration.js"

export const retired = { launchdLabel: "sh.flywl.flywheel.remote-host", systemdUnit: "flywheel-remote-host.service", windowsTask: "Flywheel Remote Host" }
export const ok = (stdout = ""): Response => ({ exitCode: 0, stdout, stderr: "" })
export const missing: Response = { exitCode: 1, stdout: "", stderr: "not found" }
export const unanswered: Response = { exitCode: null, stdout: "", stderr: "" }
export const eio: Response = { exitCode: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" }
export const launchdAbsent: Response = { exitCode: 113, stdout: "", stderr: "Bad request.\nCould not find service \"sh.flywl.flywheel.serve.reload\" in domain for user gui: 1000" }

export const launcher = { source: "/opt/flywheel/native/darwin-arm64/Flywheel.app", target: "/scratch/test/.flywheel/launcher/Flywheel.app", executable: "/scratch/test/.flywheel/launcher/Flywheel.app/Contents/MacOS/Flywheel", errorLog: "/scratch/test/.flywheel/launcher/serve.stderr.log" }
export const plistPath = "/scratch/test/Library/LaunchAgents/sh.flywl.flywheel.serve.plist"
export const service = "gui/1000/sh.flywl.flywheel.serve"
export const print = ["launchctl", "print", service]
export const helperPrint = ["launchctl", "print", `gui/1000/${SERVICE_NAMES.installed.reloadHelper}`]
export const printDisabled = ["launchctl", "print-disabled", "gui/1000"]
export const bootstrap = ["launchctl", "bootstrap", "gui/1000", plistPath]
/** The reload helper launchd receives: a leftover helper goes first, then the
 *  transient job that runs `serve reload-registration` and removes itself. */
export const removeHelper = ["launchctl", "remove", SERVICE_NAMES.installed.reloadHelper]
export const submitHelper = ["launchctl", "submit", "-l", SERVICE_NAMES.installed.reloadHelper, "--", "/bin/sh", "-c", `"$@" serve reload-registration; /bin/launchctl remove "$0"`, SERVICE_NAMES.installed.reloadHelper, "/scratch/test/bin/flywheel"]
/** Where the fixture stages a private file, as a fresh temporary directory would. */
export const taskXmlPath = "C:\\Temp\\flywheel-service-1\\task.xml"

/** The registrations the release before fingerprints wrote. Remove these
 *  fixtures with the conversions they exercise, after 2027-03-23. */
export const OLD_PLIST = [
  `<?xml version="1.0" encoding="UTF-8"?>`,
  `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
  `<plist version="1.0">`, `<dict>`, `  <key>Label</key>`, `  <string>sh.flywl.flywheel.serve</string>`,
  `  <key>ProgramArguments</key>`, `  <array>`, `    <string>${launcher.executable}</string>`, `    <string>/scratch/test/bin/flywheel</string>`, `    <string>serve</string>`, `  </array>`,
  `  <key>WorkingDirectory</key>`, `  <string>/scratch/test</string>`, `  <key>RunAtLoad</key>`, `  <true/>`, `  <key>KeepAlive</key>`, `  <true/>`,
  `  <key>ProcessType</key>`, `  <string>Background</string>`, `</dict>`, `</plist>`, ``,
].join("\n")
export const OLD_UNIT = [`[Unit]`, `Description=Flywheel account service`, `After=network-online.target`, ``, `[Service]`, `ExecStart="/scratch/test/bin/flywheel" serve`, `WorkingDirectory=/scratch/test`, `Restart=always`, `RestartSec=5`, ``, `[Install]`, `WantedBy=default.target`, ``].join("\n")
/** The unit the build before `OOMPolicy=continue` wrote. The service's
 *  ordinary refresh rewrites it, so no conversion exists and the fixture has
 *  no removal date. */
export const UNIT_BEFORE_OOM_POLICY = [
  `[Unit]`, `Description=Flywheel account service`, `After=network-online.target`, ``,
  `[Service]`, `ExecStart="/scratch/test/bin/flywheel" serve`, `WorkingDirectory=/scratch/test`, `Restart=on-failure`, `RestartSec=5`,
  `SuccessExitStatus=75`, `RestartForceExitStatus=75 SIGTERM SIGINT SIGHUP`, `TimeoutStopSec=60`, `KillMode=process`, ``,
  `[Install]`, `WantedBy=default.target`, ``,
].join("\n")
export const OLD_TASK_QUERY = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Settings><ExecutionTimeLimit>PT72H</ExecutionTimeLimit><Priority>7</Priority></Settings>
  <Actions Context="Author"><Exec><Command>"C:\\Flywheel\\flywheel.exe"</Command><Arguments>serve</Arguments></Exec></Actions>
</Task>`

export interface Response { readonly exitCode: number | null; readonly stdout: string; readonly stderr: string; readonly timedOut?: boolean }

/** `launchctl print-disabled` of the gui domain, trimmed from a real answer.
 *  Current macOS states each label as `enabled` or `disabled`; earlier
 *  releases state `false` or `true` in the same place. */
export const printedDisabled = (serviceState: "enabled" | "disabled" | "false" | "true"): string => {
  const other = serviceState === "enabled" || serviceState === "disabled" ? ["enabled", "disabled"] : ["false", "true"]
  return `\tdisabled services = {
\t\t"io.tailscale.ipn.macsys.login-item-helper" => ${other[0]}
\t\t"sh.flywl.flywheel.serve.reload" => ${other[1]}
\t\t"sh.flywl.flywheel.serve" => ${serviceState}
\t\t"com.apple.Siri.agent" => ${other[1]}
\t}
`
}

/** `launchctl print` of the loaded job, trimmed from a real answer, with the
 *  registration fingerprint launchd passes in the job's environment. */
export const printedJob = (fingerprint: string | undefined, state = "running"): string => `gui/1000/sh.flywl.flywheel.serve = {
	active count = 1
	path = ${plistPath}
	type = LaunchAgent
	state = ${state}

	program = ${launcher.executable}
	arguments = {
		${launcher.executable}
		/scratch/test/bin/flywheel
		serve
	}

	working directory = /scratch/test

	inherited environment = {
		SSH_AUTH_SOCK => /private/tmp/com.apple.launchd.tzCzuY0ctx/Listeners
	}

	default environment = {
		PATH => /usr/bin:/bin:/usr/sbin:/sbin
	}

	environment = {
		OSLogRateLimit => 64${fingerprint === undefined ? "" : `\n\t\tFLYWHEEL_SERVICE_REGISTRATION => ${fingerprint}`}
		XPC_SERVICE_NAME => sh.flywl.flywheel.serve
	}

	domain = gui/1000 [100004]
	minimum runtime = 10
	exit timeout = 60
	runs = 818
	pid = 31016
	last exit code = 0

	properties = keepalive | runatload | inferred program
}
`

/** `schtasks /Query /FO LIST /V` of the task, trimmed from the form Task
 *  Scheduler prints. "Idle Time" states Disabled for every task this build
 *  registers, so only the task's own state fields say whether it runs. */
export const listedTask = (status: string, taskState: "Enabled" | "Disabled"): string => [
  ``,
  `Folder: \\`,
  `HostName:                             DESKTOP`,
  `TaskName:                             \\Flywheel Serve`,
  `Next Run Time:                        N/A`,
  `Status:                               ${status}`,
  `Logon Mode:                           Interactive only`,
  `Last Run Time:                        9/22/2026 9:14:03 AM`,
  `Last Result:                          0`,
  `Author:                               DESKTOP\\test`,
  `Task To Run:                          C:\\Flywheel\\flywheel.exe serve`,
  `Scheduled Task State:                 ${taskState}`,
  `Idle Time:                            Disabled`,
  `Run As User:                          test`,
  ``,
].join("\r\n")

/** `schtasks /Query /FO CSV /NH`: one row for each task the user can read,
 *  with the task's full path first. */
export const listedTasks = (...names: readonly string[]): string => names.map((name) => `"${name}","N/A","Ready"\r\n`).join("")

export function textOf(contents: string | Uint8Array | undefined): string {
  if (typeof contents !== "string") throw new Error("expected a text file")
  return contents
}

export function bytesOf(contents: string | Uint8Array | undefined): Uint8Array {
  if (!(contents instanceof Uint8Array)) throw new Error("expected a binary file")
  return contents
}

export function fixture(platformName: NodeJS.Platform, responses: ReadonlyMap<string, Response | readonly Response[]> = new Map(), seeded: ReadonlyMap<string, string> = new Map(), loginHome?: string) {
  const commands: string[][] = []
  const files = new Map<string, string | Uint8Array>(seeded)
  const written: Array<readonly [string, string | Uint8Array]> = []
  const installedBundles: Array<readonly [string, string]> = []
  const accountHome = platformName === "win32" ? "C:\\Users\\test" : "/scratch/test"
  const answered = new Map<string, number>()
  let clock = 0
  const platform: AccountServicePlatform = {
    platform: platformName,
    accountHome,
    loginHome: () => loginHome ?? accountHome,
    env: platformName === "win32" ? { USERNAME: "test", USERDOMAIN: "DESKTOP" } : {},
    uid: 1000,
    command: platformName === "win32" ? ["C:\\Flywheel\\flywheel-service.exe"] : ["/scratch/test/bin/flywheel"],
    launcher: platformName === "darwin" ? launcher : undefined,
    names: SERVICE_NAMES.installed,
    retired: [retired],
    runCommand: async (command) => {
      commands.push([...command])
      const key = command.join("\0")
      const response = responses.get(key)
      if (response === undefined) return key === taskUserQuery.join("\0") ? ok('"desktop\\test","S-1-5-21-100-200-300-1001"\r\n') : ok()
      if ("exitCode" in response) return response
      // A sequence answers in order and then repeats its last answer.
      const index = answered.get(key) ?? 0
      answered.set(key, index + 1)
      return response[Math.min(index, response.length - 1)] ?? ok()
    },
    sleep: async (milliseconds) => { clock += milliseconds },
    now: () => clock,
    files: {
      exists: (path) => files.has(path),
      read: (path) => { const value = files.get(path); return typeof value === "string" ? value : undefined },
      write: (path, contents) => { files.set(path, contents); written.push([path, contents]) },
      remove: (path) => { files.delete(path) },
      installBundle: (source, target) => { installedBundles.push([source, target]) },
      withPrivateFile: async (name, contents, use) => {
        const path = `C:\\Temp\\flywheel-service-1\\${name}`
        files.set(path, contents)
        written.push([path, contents])
        try {
          return await use(path)
        } finally {
          files.delete(path)
        }
      },
    },
  }
  return { commands, files, written, installedBundles, installation: createAccountServiceInstallation(() => platform), control: accountServiceRegistrationControl(platform), platform }
}

/** The launchd registration a fresh darwin install writes today. */
export async function currentPlist(): Promise<string> {
  const setup = fixture("darwin", new Map([[print.join("\0"), missing]]))
  await setup.installation.install()
  return textOf(setup.files.get(plistPath))
}

export async function currentUnit(): Promise<string> {
  const active = ["systemctl", "--user", "is-active", "--quiet", SERVICE_NAMES.installed.systemdUnit]
  const setup = fixture("linux", new Map([[active.join("\0"), missing]]))
  await setup.installation.install()
  return textOf(setup.files.get(systemdUnitPath({ accountHome: "/scratch/test", env: {}, names: SERVICE_NAMES.installed })))
}

/** The task XML a fresh Windows install hands Task Scheduler, decoded. */
export async function currentTaskXml(): Promise<string> {
  const query = ["schtasks", "/Query", "/TN", "Flywheel Serve", "/XML"]
  const setup = fixture("win32", new Map([[query.join("\0"), missing]]))
  await setup.installation.install()
  const created = bytesOf(setup.written.find(([path]) => path === taskXmlPath)?.[1])
  expect(Array.from(created.subarray(0, 2))).toEqual([0xff, 0xfe])
  return Buffer.from(created.slice(2)).toString("utf16le")
}

export const isActive = ["systemctl", "--user", "is-active", "--quiet", SERVICE_NAMES.installed.systemdUnit]
export const isEnabled = ["systemctl", "--user", "is-enabled", "--quiet", SERVICE_NAMES.installed.systemdUnit]
export const daemonReload = ["systemctl", "--user", "daemon-reload"]
/** The systemd steps of a run. A Linux install also asks logind about
 *  lingering, which account-service-linger.test.ts covers. */
export const systemctlCommands = (commands: readonly string[][]): string[][] => commands.filter((command) => command[0] === "systemctl")
export const taskQuery = ["schtasks", "/Query", "/TN", "Flywheel Serve", "/XML"]
export const taskStatus = ["schtasks", "/Query", "/TN", "Flywheel Serve", "/FO", "LIST", "/V"]
export const taskList = ["schtasks", "/Query", "/FO", "CSV", "/NH"]
export const taskUserQuery = ["whoami", "/user", "/fo", "csv", "/nh"]

/** An installation as its callers see it: it answers `overrides`, and
 *  otherwise registers nothing and reads no lingering. */
export function installationOf(overrides: Partial<AccountServiceInstallation> = {}): AccountServiceInstallation {
  return {
    installed: async () => false,
    install: async () => {},
    uninstall: async () => {},
    start: async () => false,
    registered: async () => false,
    refresh: async () => {},
    lingerOffFor: async () => undefined,
    ...overrides,
  }
}
