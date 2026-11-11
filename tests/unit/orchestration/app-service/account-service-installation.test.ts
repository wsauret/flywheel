import { describe, expect, test } from "bun:test"

import { createAccountServiceInstallation, currentLoginHome, isLoginHome, serviceCommandLaunch } from "../../../../src/orchestration/app-service/account-service-installation.js"
import { osAccount } from "../../../../src/infra/os-account.js"
import { systemdUnitPath } from "../../../../src/orchestration/app-service/account-service-systemd.js"
import { registrationFingerprint, SERVICE_NAMES, SERVICE_STOP_TIMEOUT_SECONDS } from "../../../../src/orchestration/app-service/account-service-registration.js"
import { ACCOUNT_DRAIN_HARD_EXIT_MS } from "../../../../src/orchestration/app-service/runtime-shutdown.js"
import { retired, ok, missing, unanswered, eio, launchdAbsent, launcher, plistPath, service, print, printDisabled, bootstrap, removeHelper, submitHelper, taskXmlPath, OLD_PLIST, OLD_UNIT, OLD_TASK_QUERY, printedJob, printedDisabled, listedTask, listedTasks, textOf, bytesOf, fixture, currentPlist, currentUnit, currentTaskXml, isActive, isEnabled, daemonReload, systemctlCommands, taskQuery, taskStatus, taskList, taskUserQuery, type Response } from "./_account-service-fixtures.js"

describe("account service registration text", () => {
  test("every manager waits for a stop longer than the account's own drain bound", () => {
    expect(SERVICE_STOP_TIMEOUT_SECONDS * 1_000).toBeGreaterThan(ACCOUNT_DRAIN_HARD_EXIT_MS)
  })

  test("the LaunchAgent runs interactive, outlasts the drain, restarts after 1 s, parks on exit 0, keeps its error output beside the launcher, and carries its fingerprint", async () => {
    const plist = await currentPlist()

    expect(plist).toContain(`  <key>ProcessType</key>\n  <string>Interactive</string>`)
    // launchd appends every start's error output to this file, which sits in
    // the launcher directory that install creates for the launcher bundle.
    expect(plist).toContain(`  <key>StandardErrorPath</key>\n  <string>/scratch/test/.flywheel/launcher/serve.stderr.log</string>`)
    expect(plist).toContain(`  <key>ExitTimeOut</key>\n  <integer>60</integer>`)
    // launchd's default 10 s spacing held a service that `flywheel kill`
    // ended right after an install down for 9 s; the service parks its own
    // crash loops, so launchd restarts it after 1 s.
    expect(plist).toContain(`  <key>ThrottleInterval</key>\n  <integer>1</integer>`)
    expect(plist).toContain(`  <key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>`)
    expect(plist).not.toContain("Background")
    const fingerprint = registrationFingerprint(plist)
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(plist).toContain(`  <key>EnvironmentVariables</key>\n  <dict>\n    <key>FLYWHEEL_SERVICE_REGISTRATION</key>\n    <string>${fingerprint}</string>`)
    // launchd runs the release-invariant launcher, which runs the installed
    // command: macOS consent attaches to the launcher and survives updates.
    expect(plist).toContain(`<string>${launcher.executable}</string>\n    <string>/scratch/test/bin/flywheel</string>\n    <string>serve</string>`)
  })

  test("the systemd unit states the exit-code contract, outlasts the drain, ends only the service process, and survives an OOM kill of one of its processes", async () => {
    expect(await currentUnit()).toBe([
      `[Unit]`,
      `Description=Flywheel account service`,
      `After=network-online.target`,
      ``,
      `[Service]`,
      `ExecStart="/scratch/test/bin/flywheel" serve`,
      `WorkingDirectory=/scratch/test`,
      `Restart=on-failure`,
      `RestartSec=5`,
      `SuccessExitStatus=75`,
      `RestartForceExitStatus=75 SIGTERM SIGINT SIGHUP`,
      `TimeoutStopSec=60`,
      `KillMode=process`,
      `OOMPolicy=continue`,
      ``,
      `[Install]`,
      `WantedBy=default.target`,
      ``,
    ].join("\n"))
  })

  test("the scheduled task XML carries Flywheel's action, fingerprint, priority, and restart count", async () => {
    const xml = await currentTaskXml()
    const fingerprint = registrationFingerprint(xml)
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/)

    // The description carries the fingerprint, the account SID has full
    // access, Priority is 4 (normal) instead of Task Scheduler's default 7
    // (below normal), the restart count is 255 so the service keeps
    // restarting, and the action marker says that Task Scheduler started the
    // service.
    expect(xml).toBe(`<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Flywheel account service. FLYWHEEL_SERVICE_REGISTRATION=${fingerprint}</Description>
    <SecurityDescriptor>D:(A;;FA;;;S-1-5-21-100-200-300-1001)</SecurityDescriptor>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>S-1-5-21-100-200-300-1001</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-21-100-200-300-1001</UserId>
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
      <Command>C:\\Flywheel\\flywheel-service.exe</Command>
      <Arguments>serve --scheduled-task</Arguments>
    </Exec>
  </Actions>
</Task>`)
  })

  test.each(["WORKGROUP", "DESKTOP", undefined])("the task fingerprint does not change when USERDOMAIN is %s", async (domain) => {
    const setup = fixture("win32", new Map([[taskQuery.join("\0"), missing]]))
    setup.platform = { ...setup.platform, env: domain === undefined ? {} : { USERNAME: "test", USERDOMAIN: domain } }

    await createAccountServiceInstallation(() => setup.platform).install()

    const bytes = bytesOf(setup.written.find(([path]) => path === taskXmlPath)?.[1])
    expect(Buffer.from(bytes.slice(2)).toString("utf16le")).toBe(await currentTaskXml())
  })

  test("a registration an earlier release wrote carries no fingerprint", () => {
    expect(registrationFingerprint(OLD_PLIST)).toBeUndefined()
    expect(registrationFingerprint(OLD_UNIT)).toBeUndefined()
    expect(registrationFingerprint(OLD_TASK_QUERY)).toBeUndefined()
  })
})

describe("account service start", () => {
  test("asks launchd to start a loaded job that does not run, without killing a running one", async () => {
    const setup = fixture("darwin", new Map([[print.join("\0"), ok("state = not running")]]), new Map([[plistPath, await currentPlist()]]))

    expect(await setup.installation.start()).toBe(true)

    expect(setup.commands).toEqual([print, ["launchctl", "kickstart", service]])
  })

  test("answers a running job with no command beyond the question", async () => {
    const setup = fixture("darwin", new Map([[print.join("\0"), ok(printedJob(undefined))]]), new Map([[plistPath, await currentPlist()]]))

    expect(await setup.installation.start()).toBe(true)

    expect(setup.commands).toEqual([print])
  })

  test.each(["enabled", "false"] as const)("loads a registration file launchd does not hold and lists as %s, which RunAtLoad starts", async (listed) => {
    const setup = fixture("darwin", new Map([[print.join("\0"), launchdAbsent], [printDisabled.join("\0"), ok(printedDisabled(listed))]]), new Map([[plistPath, await currentPlist()]]))

    expect(await setup.installation.start()).toBe(true)

    expect(setup.commands).toEqual([print, printDisabled, bootstrap])
  })

  test.each(["disabled", "true"] as const)("starts nothing for a label the person disabled, which launchctl lists as %s", async (listed) => {
    // Login Items "Allow in the Background" off, or `launchctl disable`: launchd
    // loads no disabled label, so the registration is not one it runs, and the
    // client launches the service itself, as for systemd's `disabled`.
    const setup = fixture("darwin", new Map([[print.join("\0"), launchdAbsent], [printDisabled.join("\0"), ok(printedDisabled(listed))]]), new Map([[plistPath, await currentPlist()]]))

    expect(await setup.installation.start()).toBe(false)

    expect(setup.commands).toEqual([print, printDisabled])
  })

  test("fails a start whose question about disabled labels launchd did not answer", async () => {
    const setup = fixture("darwin", new Map([[print.join("\0"), launchdAbsent], [printDisabled.join("\0"), unanswered]]), new Map([[plistPath, await currentPlist()]]))

    await expect(setup.installation.start()).rejects.toThrow("launchctl print-disabled did not answer")

    expect(setup.commands).toEqual([print, printDisabled])
  })

  test("takes a load another process made first as its own", async () => {
    // A reload helper can load the same file between the question and the load.
    const setup = fixture("darwin", new Map([
      [print.join("\0"), launchdAbsent],
      [bootstrap.join("\0"), { exitCode: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error\nService already exists in domain" }],
    ]), new Map([[plistPath, await currentPlist()]]))

    expect(await setup.installation.start()).toBe(true)

    expect(setup.commands).toEqual([print, printDisabled, bootstrap])
  })

  test("takes a failed load whose label launchd then holds as its own", async () => {
    const setup = fixture("darwin", new Map<string, Response | readonly Response[]>([
      [print.join("\0"), [launchdAbsent, ok("state = running")]],
      [bootstrap.join("\0"), { exitCode: 37, stdout: "", stderr: "Bootstrap failed: 37: Operation already in progress" }],
    ]), new Map([[plistPath, await currentPlist()]]))

    expect(await setup.installation.start()).toBe(true)

    expect(setup.commands).toEqual([print, printDisabled, bootstrap, print])
  })

  test("fails a start whose question launchd did not answer, instead of reading it as nothing loaded", async () => {
    const setup = fixture("darwin", new Map([[print.join("\0"), unanswered]]), new Map([[plistPath, await currentPlist()]]))

    await expect(setup.installation.start()).rejects.toThrow("launchctl print sh.flywl.flywheel.serve did not answer")

    expect(setup.commands).toEqual([print])
  })

  test("runs no command for a home that holds no registration file", async () => {
    const setup = fixture("darwin")

    expect(await setup.installation.start()).toBe(false)

    expect(setup.commands).toEqual([])
  })

  test("asks systemd to start an enabled unit", async () => {
    const enabled = ["systemctl", "--user", "is-enabled", SERVICE_NAMES.installed.systemdUnit]
    const setup = fixture("linux", new Map([[enabled.join("\0"), ok("enabled")]]), new Map([[systemdUnitPath({ accountHome: "/scratch/test", env: {}, names: SERVICE_NAMES.installed }), "[Unit]"]]))

    expect(await setup.installation.start()).toBe(true)

    expect(setup.commands).toEqual([enabled, ["systemctl", "--user", "start", SERVICE_NAMES.installed.systemdUnit]])
  })

  test.each(["disabled", "masked", "masked-runtime", "linked", "linked-runtime", "not-found", "bad"])("starts nothing for a unit systemd names %s", async (answer) => {
    const enabled = ["systemctl", "--user", "is-enabled", SERVICE_NAMES.installed.systemdUnit]
    const setup = fixture("linux", new Map([[enabled.join("\0"), { exitCode: 1, stdout: `${answer}\n`, stderr: "" }]]), new Map([[systemdUnitPath({ accountHome: "/scratch/test", env: {}, names: SERVICE_NAMES.installed }), "[Unit]"]]))

    expect(await setup.installation.start()).toBe(false)

    expect(setup.commands).toEqual([enabled])
  })

  test("fails a start when the user bus does not answer while the unit file exists", async () => {
    const enabled = ["systemctl", "--user", "is-enabled", SERVICE_NAMES.installed.systemdUnit]
    const setup = fixture("linux", new Map([[enabled.join("\0"), { exitCode: 1, stdout: "", stderr: "Failed to connect to bus: No medium found" }]]), new Map([[systemdUnitPath({ accountHome: "/scratch/test", env: {}, names: SERVICE_NAMES.installed }), "[Unit]"]]))

    await expect(setup.installation.start()).rejects.toThrow("systemctl is-enabled failed (exit 1): Failed to connect to bus: No medium found")
  })

  test("a client's systemctl launch carries the user bus and a trusted program path", () => {
    // The trusted directories and program suffix are the host's, so only the
    // program's name and the bus variables are asserted.
    const launch = serviceCommandLaunch(["systemctl", "--user", "start", SERVICE_NAMES.installed.systemdUnit], { platform: "linux", env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" }, uid: 1000 }, () => true)

    expect(launch.argv[0]).toMatch(/systemctl(?:\.exe)?$/)
    expect(launch.argv.slice(1)).toEqual(["--user", "start", SERVICE_NAMES.installed.systemdUnit])
    expect(launch.env.XDG_RUNTIME_DIR).toBe("/run/user/1000")
    expect(launch.env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/1000/bus")
    expect(serviceCommandLaunch(["systemctl"], { platform: "linux", env: { XDG_RUNTIME_DIR: "/run/user/77" }, uid: 1000 }, () => true).env.XDG_RUNTIME_DIR).toBe("/run/user/77")
    expect(serviceCommandLaunch(["launchctl"], { platform: "darwin", env: { XDG_RUNTIME_DIR: "/scratch/x" }, uid: 1000 }, () => true).env.XDG_RUNTIME_DIR).toBeUndefined()
  })

  test("asks Task Scheduler to run a registered task", async () => {
    const setup = fixture("win32", new Map([[taskStatus.join("\0"), ok(listedTask("Ready", "Enabled"))]]))

    expect(await setup.installation.start()).toBe(true)

    expect(setup.commands).toEqual([taskStatus, ["schtasks", "/Run", "/TN", "Flywheel Serve"]])
  })

  test.each([
    ["its status", listedTask("Disabled", "Disabled")],
    ["its scheduled task state alone", listedTask("Ready", "Disabled")],
  ] as const)("starts nothing for a task the person disabled, which Task Scheduler states in %s", async (_name, listed) => {
    // Task Scheduler runs a disabled task neither at logon nor on request, so
    // the client launches the service itself, as for systemd's `disabled`.
    const setup = fixture("win32", new Map([[taskStatus.join("\0"), ok(listed)]]))

    expect(await setup.installation.start()).toBe(false)

    expect(setup.commands).toEqual([taskStatus])
  })

  test("starts nothing for a task the full task list does not name, whatever language the query failed in", async () => {
    // The query states its failure in the display language, so no text of it
    // proves the task absent. The list's task-name column is never translated.
    const absent = fixture("win32", new Map([
      [taskStatus.join("\0"), { exitCode: 1, stdout: "", stderr: "FEHLER: Das System kann die angegebene Datei nicht finden." }],
      [taskList.join("\0"), ok(listedTasks("\\Microsoft\\Windows\\Defrag\\ScheduledDefrag", "\\Flywheel Serve Old", "\\Tools\\Flywheel Serve"))],
    ]))
    expect(await absent.installation.start()).toBe(false)
    expect(absent.commands).toEqual([taskStatus, taskList])

    const silent = fixture("win32", new Map([[taskStatus.join("\0"), { exitCode: 1, stdout: "", stderr: "", timedOut: true }]]))
    await expect(silent.installation.start()).rejects.toThrow("schtasks query did not answer")
  })

  test.each([
    ["names the task", ok(listedTasks("\\flywheel serve")), "schtasks query failed (exit 1): ERROR: Access is denied."],
    ["cannot be read", { exitCode: 1, stdout: "", stderr: "ERROR: The Task Scheduler service is not available." }, "schtasks query failed (exit 1): ERROR: Access is denied. (schtasks list failed (exit 1): ERROR: The Task Scheduler service is not available.)"],
    ["does not answer", unanswered, "schtasks query failed (exit 1): ERROR: Access is denied. (schtasks list did not answer)"],
  ] as const)("fails a start whose task query failed when the task list %s, so the client never launches a second service", async (_name, list, message) => {
    // A task the manager may still hold is a starter, so only proof that no
    // task is registered lets the client launch the service itself.
    const setup = fixture("win32", new Map([
      [taskStatus.join("\0"), { exitCode: 1, stdout: "", stderr: "ERROR: Access is denied." }],
      [taskList.join("\0"), list],
    ]))

    await expect(setup.installation.start()).rejects.toThrow(message)
    expect(setup.commands).toEqual([taskStatus, taskList])
  })

  test("starts no task for an account home Task Scheduler does not serve", async () => {
    // Task Scheduler names the one task of the login user from any home, so
    // only the home check keeps an isolated home from starting the real one.
    const setup = fixture("win32", new Map(), new Map(), "C:\\Users\\other")

    expect(await setup.installation.start()).toBe(false)

    expect(setup.commands).toEqual([])
  })

  test("reports the refusal when the manager will not start a loaded registration", async () => {
    const kickstart = ["launchctl", "kickstart", service]
    const setup = fixture("darwin", new Map([[print.join("\0"), ok("state = not running")], [kickstart.join("\0"), { exitCode: 113, stdout: "", stderr: "Could not find service" }]]), new Map([[plistPath, await currentPlist()]]))

    await expect(setup.installation.start()).rejects.toThrow("launchctl kickstart failed (exit 113): Could not find service")
  })
})

describe("account service installation", () => {
  test("creates and starts missing launchd registration before retiring the old service", async () => {
    const setup = fixture("darwin", new Map([[print.join("\0"), missing]]))

    await setup.installation.install()

    expect(setup.commands).toEqual([
      print,
      bootstrap,
      ["launchctl", "bootout", "gui/1000/sh.flywl.flywheel.remote-host"],
    ])
    expect(setup.installedBundles).toEqual([[launcher.source, launcher.target]])
  })

  test("retries a bootstrap that launchd answers with an I/O error while it tears the job down", async () => {
    const setup = fixture("darwin", new Map<string, Response | readonly Response[]>([[print.join("\0"), missing], [bootstrap.join("\0"), [eio, eio, ok()]]]))

    await setup.installation.install()

    expect(setup.commands.filter((command) => command[1] === "bootstrap")).toEqual([bootstrap, bootstrap, bootstrap])
  })

  test("gives up on a bootstrap after fifteen attempts", async () => {
    const setup = fixture("darwin", new Map([[print.join("\0"), missing], [bootstrap.join("\0"), eio]]))

    await expect(setup.installation.install()).rejects.toThrow("launchctl bootstrap failed (exit 5)")

    expect(setup.commands.filter((command) => command[1] === "bootstrap")).toHaveLength(15)
  })

  test("starts a stopped launchd registration without replacing it", async () => {
    const setup = fixture("darwin", new Map([[print.join("\0"), ok("state = not running")]]), new Map([[plistPath, await currentPlist()]]))

    await setup.installation.install()

    expect(setup.commands.slice(0, 2)).toEqual([print, ["launchctl", "kickstart", service]])
    expect(setup.written).toEqual([])
  })

  test("does not restart a running launchd service", async () => {
    const setup = fixture("darwin", new Map([[print.join("\0"), ok("state = running")]]), new Map([[plistPath, await currentPlist()]]))

    await setup.installation.install()

    expect(setup.commands).not.toContainEqual(expect.arrayContaining(["bootstrap"]))
    expect(setup.commands).not.toContainEqual(expect.arrayContaining(["kickstart"]))
  })

  test("writes a changed definition for a running service and never unloads it", async () => {
    const stale = (await currentPlist()).replace(`    <string>${launcher.executable}</string>\n`, "")
    const setup = fixture("darwin", new Map([[print.join("\0"), ok("state = running")]]), new Map([[plistPath, stale]]))

    await setup.installation.install()

    expect(setup.files.get(plistPath)).toBe(await currentPlist())
    expect(setup.commands).toEqual([print, ["launchctl", "bootout", "gui/1000/sh.flywl.flywheel.remote-host"]])
  })

  test("re-registers a changed definition when the loaded job is not running", async () => {
    const setup = fixture("darwin", new Map([[print.join("\0"), ok("state = not running")]]), new Map([[plistPath, OLD_PLIST]]))

    await setup.installation.install()

    expect(setup.files.get(plistPath)).toBe(await currentPlist())
    expect(setup.commands.slice(0, 3)).toEqual([print, ["launchctl", "bootout", service], bootstrap])
  })

  test("a running service under the earlier release's registration keeps running while the new one is written", async () => {
    const setup = fixture("darwin", new Map([[print.join("\0"), ok("state = running")]]), new Map([[plistPath, OLD_PLIST]]))

    await setup.installation.install()

    expect(registrationFingerprint(textOf(setup.files.get(plistPath)))).toBeDefined()
    expect(setup.commands).not.toContainEqual(["launchctl", "bootout", service])
    expect(setup.commands).not.toContainEqual(bootstrap)
  })

  test("creates and starts missing systemd registration before retiring the old service", async () => {
    const setup = fixture("linux", new Map([[isActive.join("\0"), missing], [isEnabled.join("\0"), missing]]))

    await setup.installation.install()

    expect(setup.files.has(systemdUnitPath(setup.platform))).toBe(true)
    expect(systemctlCommands(setup.commands)).toEqual([
      isActive,
      isEnabled,
      daemonReload,
      ["systemctl", "--user", "enable", "--no-reload", "--now", SERVICE_NAMES.installed.systemdUnit],
      ["systemctl", "--user", "disable", "--no-reload", "--now", "flywheel-remote-host.service"],
      daemonReload,
    ])
  })

  test("starts stopped systemd registration without enabling it again", async () => {
    const setup = fixture("linux", new Map([[isActive.join("\0"), missing], [isEnabled.join("\0"), ok()]]), new Map([[systemdUnitPath({ accountHome: "/scratch/test", env: {}, names: SERVICE_NAMES.installed }), await currentUnit()]]))

    await setup.installation.install()

    expect(setup.commands.slice(0, 4)).toEqual([isActive, isEnabled, daemonReload, ["systemctl", "--user", "start", SERVICE_NAMES.installed.systemdUnit]])
    expect(setup.commands).not.toContainEqual(expect.arrayContaining(["enable"]))
  })

  test("does not restart a running systemd service", async () => {
    const setup = fixture("linux", new Map([[isActive.join("\0"), ok()]]), new Map([[systemdUnitPath({ accountHome: "/scratch/test", env: {}, names: SERVICE_NAMES.installed }), await currentUnit()]]))

    await setup.installation.install()

    expect(setup.commands).not.toContainEqual(expect.arrayContaining(["start"]))
    expect(setup.commands).not.toContainEqual(expect.arrayContaining(["enable"]))
  })

  test("leaves the earlier release's unit of an active service unwritten and the manager unreloaded", async () => {
    // A reload under the running earlier build would give it Restart=on-failure,
    // and that build's exit 0 on retirement would then leave nothing running.
    // A unit written now would get the same reload from any other program, so
    // only the service of the new build writes it.
    const unitPath = systemdUnitPath({ accountHome: "/scratch/test", env: {}, names: SERVICE_NAMES.installed })
    const setup = fixture("linux", new Map([[isActive.join("\0"), ok()]]), new Map([[unitPath, OLD_UNIT]]))

    await setup.installation.install()

    expect(setup.files.get(unitPath)).toBe(OLD_UNIT)
    expect(setup.written).toEqual([])
    expect(systemctlCommands(setup.commands)).toEqual([
      isActive,
      isEnabled,
      ["systemctl", "--user", "disable", "--no-reload", "--now", "flywheel-remote-host.service"],
    ])
  })

  test("enables a disabled running systemd service without restarting it, writing its unit, or reloading the manager", async () => {
    const unitPath = systemdUnitPath({ accountHome: "/scratch/test", env: {}, names: SERVICE_NAMES.installed })
    const setup = fixture("linux", new Map([[isActive.join("\0"), ok()], [isEnabled.join("\0"), missing]]), new Map([[unitPath, OLD_UNIT]]))

    await setup.installation.install()

    expect(setup.files.get(unitPath)).toBe(OLD_UNIT)

    expect(setup.commands).toContainEqual(["systemctl", "--user", "enable", "--no-reload", SERVICE_NAMES.installed.systemdUnit])
    expect(setup.commands).not.toContainEqual(daemonReload)
    expect(setup.commands).not.toContainEqual(expect.arrayContaining(["start"]))
    expect(setup.commands).not.toContainEqual(expect.arrayContaining(["restart"]))
  })

  test("creates a missing Windows task from its XML and starts it", async () => {
    const setup = fixture("win32", new Map([
      [taskUserQuery.join("\0"), ok('"examplepc\\alice","S-1-5-21-1000000000-2000000000-3000000000-1001"\r\n')],
      [taskQuery.join("\0"), missing],
      [taskStatus.join("\0"), ok("Status: Ready")],
    ]))

    await setup.installation.install()

    expect(setup.commands.slice(0, 5)).toEqual([
      taskUserQuery,
      taskQuery,
      ["schtasks", "/Create", "/F", "/TN", "Flywheel Serve", "/XML", taskXmlPath],
      taskStatus,
      ["schtasks", "/Run", "/TN", "Flywheel Serve"],
    ])
    expect(setup.commands.filter((command) => command[0] === "whoami")).toHaveLength(1)
    const bytes = bytesOf(setup.written.find(([path]) => path === taskXmlPath)?.[1])
    const xml = Buffer.from(bytes.slice(2)).toString("utf16le")
    expect(xml.match(/<UserId>S-1-5-21-1000000000-2000000000-3000000000-1001<\/UserId>/g)).toHaveLength(2)
    expect(xml).toContain("<SecurityDescriptor>D:(A;;FA;;;S-1-5-21-1000000000-2000000000-3000000000-1001)</SecurityDescriptor>")
    expect(setup.files.has(taskXmlPath)).toBe(false)
  })

  test.each([
    "",
    '"desktop\\test","not-a-sid"',
    '"desktop\\test","S-1-5-abc"',
    '"desktop\\test","S-1-5-21-1001","unexpected"',
    '"desktop\\test","S-1-5-21-1001"\r\n"desktop\\other","S-1-5-21-1002"',
  ])("refuses Windows registration when whoami returns malformed CSV or a non-SID: %s", async (stdout) => {
    const setup = fixture("win32", new Map([[taskUserQuery.join("\0"), ok(stdout)]]))

    await expect(setup.installation.install()).rejects.toMatchObject({
      _tag: "AccountServiceInstallationError",
      message: "whoami /user returned no valid account SID",
    })

    expect(setup.commands).toEqual([taskUserQuery])
    expect(setup.written).toEqual([])
  })

  test.each([
    [missing, "whoami /user failed (exit 1): not found"],
    [unanswered, "whoami /user did not answer"],
    [{ ...ok('"desktop\\test","S-1-5-21-1001"'), timedOut: true }, "whoami /user did not answer"],
  ] as const)("refuses Windows registration when whoami fails: %j", async (response, message) => {
    const setup = fixture("win32", new Map([[taskUserQuery.join("\0"), response]]))

    await expect(setup.installation.install()).rejects.toMatchObject({ _tag: "AccountServiceInstallationError", message })

    expect(setup.commands).toEqual([taskUserQuery])
    expect(setup.written).toEqual([])
  })

  test("starts a stopped Windows task without recreating it", async () => {
    const setup = fixture("win32", new Map([[taskQuery.join("\0"), ok(await currentTaskXml())], [taskStatus.join("\0"), ok("Status: Ready")]]))

    await setup.installation.install()

    expect(setup.commands.slice(0, 4)).toEqual([taskUserQuery, taskQuery, taskStatus, ["schtasks", "/Run", "/TN", "Flywheel Serve"]])
    expect(setup.commands).not.toContainEqual(expect.arrayContaining(["/Create"]))
  })

  test.each([
    ["with a byte-order mark", (xml: string) => `\uFEFF${xml}`],
    ["as UTF-16 with a NUL beside every character", (xml: string) => `\uFEFF${xml.split("").join("\u0000")}`],
  ] as const)("reads the registered task's fingerprint from a query answered %s", async (_name, encode) => {
    const setup = fixture("win32", new Map([[taskQuery.join("\0"), ok(encode(await currentTaskXml()))], [taskStatus.join("\0"), ok("Status: Running")]]))

    await setup.installation.install()

    expect(setup.commands).not.toContainEqual(expect.arrayContaining(["/Create"]))
  })

  test("does not restart a running Windows task", async () => {
    const setup = fixture("win32", new Map([[taskQuery.join("\0"), ok(await currentTaskXml())], [taskStatus.join("\0"), ok("Status: Running")]]))

    await setup.installation.install()

    expect(setup.commands).not.toContainEqual(expect.arrayContaining(["/Run"]))
    expect(setup.commands).not.toContainEqual(expect.arrayContaining(["/Create"]))
  })

  test("recreates the earlier release's task in place for a running service with no stop", async () => {
    const setup = fixture("win32", new Map([[taskQuery.join("\0"), ok(OLD_TASK_QUERY)], [taskStatus.join("\0"), ok("Status: Running")]]))

    await setup.installation.install()

    expect(setup.commands.slice(0, 4)).toEqual([taskUserQuery, taskQuery, ["schtasks", "/Create", "/F", "/TN", "Flywheel Serve", "/XML", taskXmlPath], taskStatus])
    expect(setup.commands).not.toContainEqual(["schtasks", "/End", "/TN", "Flywheel Serve"])
    expect(setup.commands).not.toContainEqual(expect.arrayContaining(["/Run"]))
  })

  test.each([["darwin", "/scratch/other"], ["linux", "/scratch/other"], ["win32", "C:\\Users\\other"]] as const)(
    "registers nothing on %s for an account home the login user's service manager does not serve",
    async (platformName, loginHome) => {
      const setup = fixture(platformName, new Map(), new Map(), loginHome)

      expect(await setup.installation.installed()).toBeNull()
      expect(await setup.installation.registered()).toBe(false)
      await setup.installation.install()
      await setup.installation.refresh()
      await setup.installation.uninstall()

      expect(setup.commands).toEqual([])
      expect(setup.files.size).toBe(0)
      expect(setup.installedBundles).toEqual([])
    },
  )

  test.each([
    ["darwin", "/scratch/test", "/scratch/test", true],
    ["darwin", "/scratch/test", "/scratch/other", false],
    ["darwin", "/scratch/test", undefined, undefined],
    ["win32", "C:\\Users\\Test", "c:\\users\\test", true],
    ["win32", "C:\\Users\\Test", "C:\\Users\\Other", false],
  ] as const)("on %s, account home %s with login home %s is the login home: %s (undefined when the platform cannot say)", (platform, accountHome, login, expected) => {
    expect(isLoginHome({ platform, accountHome, loginHome: () => login })).toBe(expected)
  })

  test("names the login home as the account database states it, so a client in an isolated home launches its service with no command", () => {
    // A client asks before it launches the service, and a command's answer
    // would reach it only after the interface's synchronous load ends. The
    // read takes no command runner, so it can run none.
    expect(currentLoginHome()).toBe(osAccount().home)
  })

  test("registers when the login home cannot be determined", async () => {
    const setup = fixture("darwin", new Map([[print.join("\0"), missing]]))
    setup.platform = { ...setup.platform, loginHome: () => undefined }
    const installation = createAccountServiceInstallation(() => setup.platform)

    await installation.install()

    expect(setup.commands[0]).toEqual(print)
    expect(setup.files.has(plistPath)).toBe(true)
  })

  test("preserves retired registration when new registration fails", async () => {
    const enable = ["systemctl", "--user", "enable", "--no-reload", "--now", SERVICE_NAMES.installed.systemdUnit]
    const setup = fixture("linux", new Map([
      [isActive.join("\0"), missing],
      [isEnabled.join("\0"), missing],
      [enable.join("\0"), { ...missing, stderr: "manager unavailable" }],
    ]))
    const retiredPath = systemdUnitPath(setup.platform).replace(SERVICE_NAMES.installed.systemdUnit, retired.systemdUnit)
    setup.files.set(retiredPath, "old")

    await expect(setup.installation.install()).rejects.toThrow("manager unavailable")

    expect(setup.files.has(retiredPath)).toBe(true)
    expect(setup.commands).not.toContainEqual(expect.arrayContaining([retired.systemdUnit]))
  })
})

describe("Process initiation off", () => {
  /** The installation of `setup`, and whether `path` was on disk as each of
   *  its commands ran. */
  const tracing = (setup: ReturnType<typeof fixture>, path: string) => {
    const onDisk: boolean[] = []
    const installation = createAccountServiceInstallation(() => ({
      ...setup.platform,
      runCommand: async (command) => {
        onDisk.push(setup.files.has(path))
        return await setup.platform.runCommand(command)
      },
    }))
    return { installation, onDisk }
  }

  test("macOS removes the registration file first and hands the unload of a loaded job to a helper outside the service's tree", async () => {
    // Off can run inside the service it turns off, so it never boots its
    // own job out. The removal alone already holds at the next login.
    const setup = fixture("darwin", new Map([[print.join("\0"), ok(printedJob(undefined))]]), new Map([[plistPath, await currentPlist()]]))
    const { installation, onDisk } = tracing(setup, plistPath)

    await installation.uninstall()

    expect(setup.commands).toEqual([print, removeHelper, submitHelper])
    expect(onDisk).toEqual([false, false, false])
  })

  test("macOS submits no helper for a label launchd does not hold", async () => {
    const setup = fixture("darwin", new Map([[print.join("\0"), launchdAbsent]]), new Map([[plistPath, await currentPlist()]]))

    await setup.installation.uninstall()

    expect(setup.commands).toEqual([print])
    expect(setup.files.has(plistPath)).toBe(false)
  })

  test.each([
    ["refuses its helper", [submitHelper, { exitCode: 1, stdout: "", stderr: "Job submission failed" }], "launchctl submit failed (exit 1): Job submission failed"],
    ["does not answer whether it holds the job", [print, unanswered], "launchctl print sh.flywl.flywheel.serve did not answer"],
  ] as const)("macOS fails an Off when launchd %s, with the registration file already gone", async (_name, [command, answer], message) => {
    const setup = fixture("darwin", new Map([[print.join("\0"), ok(printedJob(undefined))], [command.join("\0"), answer]]), new Map([[plistPath, await currentPlist()]]))

    await expect(setup.installation.uninstall()).rejects.toThrow(message)

    expect(setup.files.has(plistPath)).toBe(false)
    expect(setup.commands).not.toContainEqual(["launchctl", "bootout", service])
  })

  test("reads Process initiation off once the registration file is gone, whatever launchd still holds", async () => {
    const withFile = fixture("darwin", new Map([[print.join("\0"), ok(printedJob(undefined))]]), new Map([[plistPath, await currentPlist()]]))
    expect(await withFile.installation.installed()).toBe(true)

    // The helper that Off submitted can still be unloading the job.
    const withoutFile = fixture("darwin", new Map([[print.join("\0"), ok(printedJob(undefined))]]))
    expect(await withoutFile.installation.installed()).toBe(false)
    expect(withoutFile.commands).toEqual([])
  })

  const disable = ["systemctl", "--user", "disable", "--no-reload", SERVICE_NAMES.installed.systemdUnit]
  const transientStop = ["systemd-run", "--user", "--collect", "--quiet", "--", "/bin/sh", "-c", `systemctl --user stop "$0"; systemctl --user daemon-reload`, SERVICE_NAMES.installed.systemdUnit]

  test("Linux disables the unit without a reload, removes its file, and leaves the stop and the reload to a transient unit outside the service's control group", async () => {
    // The stop goes before the reload, so the stop still runs under the
    // unit's own KillMode and TimeoutStopSec.
    const unitPath = systemdUnitPath({ accountHome: "/scratch/test", env: {}, names: SERVICE_NAMES.installed })
    const setup = fixture("linux", new Map(), new Map([[unitPath, await currentUnit()]]))
    const { installation, onDisk } = tracing(setup, unitPath)

    await installation.uninstall()

    expect(setup.commands).toEqual([disable, transientStop])
    expect(onDisk).toEqual([true, false])
  })

  test("Linux fails an Off whose transient unit systemd refuses, with the unit file already gone", async () => {
    const unitPath = systemdUnitPath({ accountHome: "/scratch/test", env: {}, names: SERVICE_NAMES.installed })
    const setup = fixture("linux", new Map([[transientStop.join("\0"), { exitCode: 1, stdout: "", stderr: "Failed to connect to bus" }]]), new Map([[unitPath, await currentUnit()]]))

    await expect(setup.installation.uninstall()).rejects.toThrow("systemd-run failed (exit 1): Failed to connect to bus")

    expect(setup.files.has(unitPath)).toBe(false)
  })

  test("Windows deletes the task and leaves its running instance alone", async () => {
    // Task Scheduler never restarts the service on its exit, so the instance
    // serves until it exits and nothing starts it again.
    const setup = fixture("win32")

    await setup.installation.uninstall()

    expect(setup.commands).toEqual([["schtasks", "/Delete", "/F", "/TN", "Flywheel Serve"]])
  })
})

describe("an update's registration refresh", () => {
  const taskAbsent: Response = { exitCode: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." }
  // Only a full task list that does not name the task proves a failed query's
  // task absent.
  const otherTasks = ok(listedTasks("\\Microsoft\\Windows\\Defrag\\ScheduledDefrag"))
  const unitPath = systemdUnitPath({ accountHome: "/scratch/test", env: {}, names: SERVICE_NAMES.installed })

  test.each([
    ["a launchd registration file", true, "darwin", [plistPath, "<plist/>"], new Map(), []],
    ["no launchd registration file", false, "darwin", undefined, new Map(), []],
    ["a systemd unit file", true, "linux", [unitPath, "[Unit]"], new Map(), []],
    ["no systemd unit file", false, "linux", undefined, new Map(), []],
    ["a task the person disabled", true, "win32", undefined, new Map([[taskStatus.join("\0"), ok(listedTask("Disabled", "Disabled"))]]), [taskStatus]],
    ["no task", false, "win32", undefined, new Map([[taskStatus.join("\0"), taskAbsent], [taskList.join("\0"), otherTasks]]), [taskStatus, taskList]],
  ] as const)("%s reads as registered: %p", async (_name, expected, platformName, file, responses, commands) => {
    // A registration the person disabled is still one, and a registration
    // file answers without a command.
    const setup = fixture(platformName, responses, new Map(file === undefined ? [] : [file]))

    expect(await setup.installation.registered()).toBe(expected)

    expect(setup.commands).toEqual([...commands])
  })

  test("on Windows a task query that fails reads as no registration only when the full task list does not name the task", async () => {
    // A registration the manager may hold keeps residency from following an
    // absence that nothing proved.
    const setup = fixture("win32", new Map([
      [taskStatus.join("\0"), { exitCode: 1, stdout: "", stderr: "ERROR: Access is denied." }],
      [taskList.join("\0"), ok(listedTasks("\\Flywheel Serve"))],
    ]))

    await expect(setup.installation.registered()).rejects.toThrow("schtasks query failed (exit 1): ERROR: Access is denied.")

    expect(setup.commands).toEqual([taskStatus, taskList])
  })

  test.each([
    ["darwin", [plistPath, "<plist/>"], new Map(), []],
    ["linux", [unitPath, "[Unit]"], new Map(), []],
    ["win32", undefined, new Map([[taskStatus.join("\0"), ok(listedTask("Ready", "Enabled"))]]), [taskStatus, taskStatus, taskStatus]],
  ] as const)("on %s reads the service's own login-home answer at every registration read, and never asks the platform", async (platformName, file, responses, commands) => {
    // The service remembers an answered login home for its lifetime, so the
    // build tick that reads the registration asks the account database nothing.
    const setup = fixture(platformName, responses, new Map(file === undefined ? [] : [file]))
    setup.platform = { ...setup.platform, loginHome: () => { throw new Error("the platform's login home must not be asked") } }
    let answers = 0
    const installation = createAccountServiceInstallation(() => setup.platform, async () => { answers += 1; return true })

    for (let tick = 0; tick < 3; tick++) expect(await installation.registered()).toBe(true)

    expect(answers).toBe(3)
    expect(setup.commands).toEqual([...commands])
  })

  test.each([
    ["darwin", new Map([[print.join("\0"), missing]]), []],
    ["linux", new Map([[isActive.join("\0"), missing], [isEnabled.join("\0"), missing]]), []],
    ["win32", new Map([[taskStatus.join("\0"), taskAbsent], [taskList.join("\0"), otherTasks], [taskQuery.join("\0"), missing]]), [taskStatus, taskList]],
  ] as const)("on %s creates no registration that is missing, so a person's Off holds through the update", async (platformName, responses, commands) => {
    const setup = fixture(platformName, responses)

    await setup.installation.refresh()

    expect(setup.commands).toEqual([...commands])
    expect(setup.written).toEqual([])
    expect(setup.installedBundles).toEqual([])
  })

  test.each([
    ["darwin", new Map([[print.join("\0"), ok("state = not running")]]), [plistPath, OLD_PLIST]],
    ["linux", new Map([[isActive.join("\0"), missing], [isEnabled.join("\0"), ok()]]), [unitPath, OLD_UNIT]],
    ["win32", new Map([[taskStatus.join("\0"), ok(listedTask("Ready", "Enabled"))], [taskQuery.join("\0"), ok(OLD_TASK_QUERY)]]), undefined],
  ] as const)("on %s refreshes a registration that exists exactly as install does", async (platformName, responses, file) => {
    const seeded = new Map(file === undefined ? [] : [file])
    const refreshed = fixture(platformName, responses, seeded)
    const installed = fixture(platformName, responses, seeded)

    await refreshed.installation.refresh()
    await installed.installation.install()

    // Each case rewrites the earlier release's registration and starts it.
    expect(installed.written).not.toEqual([])
    expect(refreshed.written).toEqual(installed.written)
    expect(refreshed.installedBundles).toEqual(installed.installedBundles)
    // Only Task Scheduler is asked whether the task exists.
    expect(refreshed.commands).toEqual(platformName === "win32" ? [taskStatus, ...installed.commands] : installed.commands)
  })

  test("on Windows fails when Task Scheduler does not answer whether the task exists, and creates nothing", async () => {
    const setup = fixture("win32", new Map([[taskStatus.join("\0"), unanswered]]))

    await expect(setup.installation.refresh()).rejects.toThrow("schtasks query did not answer")

    expect(setup.commands).toEqual([taskStatus])
    expect(setup.written).toEqual([])
  })
})
