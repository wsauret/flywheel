import { describe, expect, test } from "bun:test"

import { reloadLaunchdRegistration } from "../../../../src/orchestration/app-service/account-service-installation.js"
import { systemdUnitPath } from "../../../../src/orchestration/app-service/account-service-systemd.js"
import { registrationFingerprint, type RegistrationReloadRecord, SERVICE_NAMES } from "../../../../src/orchestration/app-service/account-service-registration.js"
import { ok, unanswered, eio, launchdAbsent, plistPath, service, print, helperPrint, printDisabled, printedDisabled, bootstrap, removeHelper, submitHelper, OLD_PLIST, OLD_UNIT, UNIT_BEFORE_OOM_POLICY, printedJob, fixture, currentPlist, currentUnit, daemonReload, type Response } from "./_account-service-fixtures.js"

describe("launchd re-registration", () => {
  const launchd = (setup: ReturnType<typeof fixture>) => {
    const control = setup.control.launchd
    if (control === undefined) throw new Error("expected the launchd registration control")
    return control
  }
  // launchd reports the helper job's own process, the shell whose child the
  // reload is, so a reload proves itself by its parent pid.
  const HELPER_PID = 4242
  const helperCaller = { parentPid: HELPER_PID }
  const helperRunning = [helperPrint.join("\0"), ok(`state = running\n\tpid = ${HELPER_PID}`)] as const
  const kickstart = ["launchctl", "kickstart", service]
  const stale = "aaaaaaaaaaaaaaaa"
  /** Runs the reload with its loop-guard records in the command log, so a
   *  test sees what the reload recorded and what it ran after that. */
  const reload = (setup: ReturnType<typeof fixture>, caller: { readonly parentPid: number } = helperCaller) => {
    const records: RegistrationReloadRecord[] = []
    const run = reloadLaunchdRegistration(setup.platform, caller, (record) => {
      records.push(record)
      setup.commands.push(["record", record.outcome])
    })
    return { run, records }
  }
  const afterRecord = (setup: ReturnType<typeof fixture>) => setup.commands.slice(setup.commands.findIndex((command) => command[0] === "record") + 1)

  test("is the registration control of macOS alone", () => {
    expect(fixture("darwin").control.systemd).toBeUndefined()
    expect(fixture("linux").control.launchd).toBeUndefined()
    expect(fixture("win32").control).toEqual({})
  })

  test("hands the reload to a transient launchd job that removes itself whatever the reload's status", async () => {
    const setup = fixture("darwin")

    expect(await launchd(setup).handOffReload()).toBeUndefined()

    expect(setup.commands).toEqual([removeHelper, submitHelper])
  })

  test("answers the refusal of a hand-off launchd refused", async () => {
    const setup = fixture("darwin", new Map([[submitHelper.join("\0"), { exitCode: 1, stdout: "", stderr: "Job submission failed" }]]))

    expect(await launchd(setup).handOffReload()).toBe("launchctl submit failed (exit 1): Job submission failed")
  })

  test.each([
    ["did not answer", unanswered],
    ["its runner ended at its timeout", { exitCode: 1, stdout: "", stderr: "", timedOut: true }],
  ] as const)("fails a hand-off whose submit %s, because the helper may be loaded", async (_name, answer) => {
    const setup = fixture("darwin", new Map([[submitHelper.join("\0"), answer]]))

    await expect(launchd(setup).handOffReload()).rejects.toThrow("launchctl submit did not answer")
  })

  test("says whether a reload helper is loaded, and fails a question launchd did not answer", async () => {
    expect(await launchd(fixture("darwin", new Map([[helperPrint.join("\0"), ok("state = running")]]))).reloadInFlight()).toBe(true)
    expect(await launchd(fixture("darwin", new Map([[helperPrint.join("\0"), launchdAbsent]]))).reloadInFlight()).toBe(false)
    await expect(launchd(fixture("darwin", new Map([[helperPrint.join("\0"), unanswered]]))).reloadInFlight()).rejects.toThrow("did not answer")
  })

  test("the helper boots the job out, waits for it to leave, bootstraps the file on disk, and records the reload", async () => {
    const plist = await currentPlist()
    const setup = fixture("darwin", new Map<string, Response | readonly Response[]>([
      helperRunning,
      [print.join("\0"), [ok(printedJob(stale)), ok("state = running"), launchdAbsent]],
      [bootstrap.join("\0"), [eio, ok()]],
    ]), new Map([[plistPath, plist]]))

    const { run, records } = reload(setup)
    await run

    expect(setup.commands).toEqual([
      helperPrint,
      printDisabled,
      print,
      ["launchctl", "bootout", service],
      print,
      print,
      bootstrap,
      // A failed load asks whether the label is loaded after all.
      print,
      bootstrap,
      ["record", "reloaded"],
    ])
    expect(records).toEqual([{ fingerprint: registrationFingerprint(plist) ?? "", outcome: "reloaded" }])
  })

  test("a client's load of the registration on disk while the helper waits for the bootout ends the reload", async () => {
    // A client that finds nothing listening bootstraps the file on disk, and
    // that load can land between the bootout and the helper's next probe.
    const plist = await currentPlist()
    const setup = fixture("darwin", new Map<string, Response | readonly Response[]>([
      helperRunning,
      [print.join("\0"), [ok(printedJob(stale)), ok(printedJob(stale)), ok(printedJob(registrationFingerprint(plist)))]],
    ]), new Map([[plistPath, plist]]))

    const { run, records } = reload(setup)
    await run

    expect(setup.commands).toEqual([helperPrint, printDisabled, print, ["launchctl", "bootout", service], print, print, ["record", "reloaded"]])
    expect(records).toEqual([{ fingerprint: registrationFingerprint(plist) ?? "", outcome: "reloaded" }])
  })

  test("the helper changes nothing when launchd already holds the registration on disk", async () => {
    // A helper that runs a second time, after a restart of its own shell,
    // finds its work done.
    const plist = await currentPlist()
    const setup = fixture("darwin", new Map<string, Response | readonly Response[]>([helperRunning, [print.join("\0"), ok(printedJob(registrationFingerprint(plist)))]]), new Map([[plistPath, plist]]))

    await reload(setup).run

    expect(setup.commands).toEqual([helperPrint, printDisabled, print, ["record", "reloaded"]])
  })

  test("the helper loads the file when launchd holds no job", async () => {
    const setup = fixture("darwin", new Map<string, Response | readonly Response[]>([helperRunning, [print.join("\0"), launchdAbsent]]), new Map([[plistPath, await currentPlist()]]))

    await reload(setup).run

    expect(setup.commands).toEqual([helperPrint, printDisabled, print, bootstrap, ["record", "reloaded"]])
  })

  test("a load that fails is recorded, and the file on disk is loaded again so the service does not stay down", async () => {
    const plist = await currentPlist()
    const setup = fixture("darwin", new Map<string, Response | readonly Response[]>([
      helperRunning,
      [print.join("\0"), [ok(printedJob(stale)), launchdAbsent]],
      [bootstrap.join("\0"), eio],
    ]), new Map([[plistPath, plist]]))

    const { run, records } = reload(setup)
    await expect(run).rejects.toThrow("launchctl bootstrap failed (exit 5)")

    expect(records).toEqual([{ fingerprint: registrationFingerprint(plist) ?? "", outcome: "failed", error: "launchctl bootstrap failed (exit 5): Bootstrap failed: 5: Input/output error" }])
    expect(afterRecord(setup).slice(0, 3)).toEqual([print, printDisabled, bootstrap])
  })

  test("a job that outlives its exit timeout is recorded as failed and started when launchd holds it stopped", async () => {
    // The stale start parked with exit 0, which KeepAlive does not restart,
    // and the bootout never took the job away.
    const setup = fixture("darwin", new Map<string, Response | readonly Response[]>([
      helperRunning,
      [print.join("\0"), [ok(printedJob(stale)), ok(printedJob(stale, "not running"))]],
    ]), new Map([[plistPath, await currentPlist()]]))

    const { run, records } = reload(setup)
    await expect(run).rejects.toThrow("did not leave launchd within 60 seconds")

    expect(records.map((record) => record.outcome)).toEqual(["failed"])
    expect(afterRecord(setup)).toEqual([print, kickstart])
    expect(setup.commands).not.toContainEqual(bootstrap)
  })

  test("never turns a service the person turned off in Login Items back on", async () => {
    // Turning the item off does not unload a job that runs, so a reload can
    // still meet a loaded label the person disabled.
    const plist = await currentPlist()
    const setup = fixture("darwin", new Map<string, Response | readonly Response[]>([
      helperRunning,
      [printDisabled.join("\0"), ok(printedDisabled("disabled"))],
      [print.join("\0"), ok(printedJob(stale))],
    ]), new Map([[plistPath, plist]]))

    const { run, records } = reload(setup)
    await expect(run).rejects.toThrow("turned off in Login Items")

    expect(records.map((record) => record.outcome)).toEqual(["failed"])
    expect(setup.commands).not.toContainEqual(["launchctl", "bootout", service])
    expect(setup.commands).not.toContainEqual(bootstrap)
    expect(setup.commands).not.toContainEqual(["launchctl", "enable", service])
  })

  test("a failed reload leaves a job that still runs alone", async () => {
    const setup = fixture("darwin", new Map<string, Response | readonly Response[]>([helperRunning, [print.join("\0"), ok(printedJob(stale))]]), new Map([[plistPath, await currentPlist()]]))

    await expect(reload(setup).run).rejects.toThrow("did not leave launchd within 60 seconds")

    expect(afterRecord(setup)).toEqual([print])
  })

  test("a helper that finds the earlier release's unfingerprinted registration on disk refuses it and still leaves the job running", async () => {
    const setup = fixture("darwin", new Map<string, Response | readonly Response[]>([helperRunning, [print.join("\0"), ok("state = not running")]]), new Map([[plistPath, OLD_PLIST]]))

    const { run, records } = reload(setup)
    await expect(run).rejects.toThrow("no fingerprinted account service registration")

    expect(records).toEqual([])
    expect(setup.commands).toEqual([helperPrint, print, kickstart])
  })

  test("a helper that cannot read the registration file on disk refuses it and still leaves the job running", async () => {
    // Only a file that is gone is Process initiation Off's. A file that is
    // there but cannot be read is refused as a file without a fingerprint is.
    const setup = fixture("darwin", new Map<string, Response | readonly Response[]>([helperRunning, [print.join("\0"), ok("state = not running")]]))
    setup.files.set(plistPath, new Uint8Array([0xff]))

    const { run, records } = reload(setup)
    await expect(run).rejects.toThrow("no fingerprinted account service registration")

    expect(records).toEqual([])
    expect(setup.commands).toEqual([helperPrint, print, kickstart])
  })

  test("with no registration file on disk, the helper boots the job out, waits until launchd no longer holds it, loads nothing, and records nothing", async () => {
    // Process initiation Off removed the file and handed the unload to the
    // helper. The job of a release before fingerprints carries none, so the
    // wait must not read it as the registration on disk.
    const setup = fixture("darwin", new Map<string, Response | readonly Response[]>([
      helperRunning,
      [print.join("\0"), [ok(printedJob(undefined)), ok(printedJob(undefined)), launchdAbsent]],
    ]))

    const { run, records } = reload(setup)
    await run

    expect(setup.commands).toEqual([helperPrint, print, ["launchctl", "bootout", service], print, print])
    expect(records).toEqual([])
  })

  test("with no registration file on disk and no job loaded, the helper changes nothing", async () => {
    const setup = fixture("darwin", new Map<string, Response | readonly Response[]>([helperRunning, [print.join("\0"), launchdAbsent]]))

    await reload(setup).run

    expect(setup.commands).toEqual([helperPrint, print])
  })

  test("with no registration file on disk, an unload run by a process that is not the helper job is refused and changes nothing", async () => {
    const setup = fixture("darwin", new Map<string, Response | readonly Response[]>([helperRunning, [print.join("\0"), ok(printedJob(undefined))]]))

    const { run, records } = reload(setup, { parentPid: 999 })
    await expect(run).rejects.toThrow(`serve reload-registration runs only as the launchd job ${SERVICE_NAMES.installed.reloadHelper}`)

    expect(records).toEqual([])
    expect(setup.commands).toEqual([helperPrint])
  })

  test("with no registration file on disk, a job that outlives its exit timeout fails the unload, which starts and loads nothing", async () => {
    // Off already removed the file, so a recovery that started the job again
    // would turn the service back on.
    const setup = fixture("darwin", new Map<string, Response | readonly Response[]>([helperRunning, [print.join("\0"), ok(printedJob(undefined, "not running"))]]))

    const { run, records } = reload(setup)
    await expect(run).rejects.toThrow("did not leave launchd within 60 seconds")

    expect(records).toEqual([])
    expect(setup.commands).not.toContainEqual(kickstart)
    expect(setup.commands).not.toContainEqual(bootstrap)
  })

  test.each([
    ["a process whose parent is not the helper job", { parentPid: 999 }, ok(`state = running\n\tpid = ${HELPER_PID}`)],
    ["a process when no helper job is loaded", helperCaller, launchdAbsent],
  ] as const)("reload-registration run as %s is refused, recorded, and leaves the job running", async (_name, caller, helperAnswer) => {
    // The refusal is inside the region that recovers, so a stale start parked
    // for this reload never leaves the resident service down.
    const plist = await currentPlist()
    const setup = fixture("darwin", new Map([[helperPrint.join("\0"), helperAnswer], [print.join("\0"), ok("state = not running")]]), new Map([[plistPath, plist]]))

    const { run, records } = reload(setup, caller)
    await expect(run).rejects.toThrow(`serve reload-registration runs only as the launchd job ${SERVICE_NAMES.installed.reloadHelper}`)

    expect(records).toEqual([{ fingerprint: registrationFingerprint(plist) ?? "", outcome: "failed", error: `serve reload-registration runs only as the launchd job ${SERVICE_NAMES.installed.reloadHelper}, outside the account service's own process tree` }])
    expect(afterRecord(setup)).toEqual([print, kickstart])
    expect(setup.commands).not.toContainEqual(["launchctl", "bootout", service])
  })

  test("a reload whose outcome cannot be recorded still leaves the job running", async () => {
    const setup = fixture("darwin", new Map<string, Response | readonly Response[]>([helperRunning, [print.join("\0"), launchdAbsent]]), new Map([[plistPath, await currentPlist()]]))

    const run = reloadLaunchdRegistration(setup.platform, helperCaller, () => { throw new Error("the serve directory is read-only") })
    await expect(run).rejects.toThrow("the serve directory is read-only")

    // The reload loaded the file, and the recovery asks launchd again.
    expect(setup.commands).toEqual([helperPrint, printDisabled, print, bootstrap, print, printDisabled, bootstrap])
  })

  test("reads the registration on disk and the job's process", async () => {
    const plist = await currentPlist()
    const setup = fixture("darwin", new Map([[print.join("\0"), ok(printedJob(undefined))]]), new Map([[plistPath, plist]]))

    expect(await launchd(setup).registeredFingerprint()).toBe(registrationFingerprint(plist))
    expect(await launchd(setup).jobPid()).toBe(31016)
    expect(await launchd(fixture("darwin")).registeredFingerprint()).toBeUndefined()
  })
})

describe("systemd unit refresh", () => {
  const show = ["systemctl", "--user", "show", "-p", "NeedDaemonReload", SERVICE_NAMES.installed.systemdUnit]
  const unitPath = systemdUnitPath({ accountHome: "/scratch/test", env: {}, names: SERVICE_NAMES.installed })
  const systemd = (setup: ReturnType<typeof fixture>) => {
    const control = setup.control.systemd
    if (control === undefined) throw new Error("expected the systemd registration control")
    return control
  }

  test.each([
    ["the release before the exit-code contract", OLD_UNIT],
    ["the build before OOMPolicy", UNIT_BEFORE_OOM_POLICY],
  ])("the service writes its own build's unit over the unit of %s and reloads the manager, which stops nothing", async (_writer, earlier) => {
    const setup = fixture("linux", new Map(), new Map([[unitPath, earlier]]))

    expect(await systemd(setup).refreshUnit()).toBe(true)

    expect(setup.files.get(unitPath)).toBe(await currentUnit())
    expect(setup.commands).toEqual([daemonReload])
  })

  test("the service reloads a current unit file that systemd has not loaded yet", async () => {
    const setup = fixture("linux", new Map([[show.join("\0"), ok("NeedDaemonReload=yes\n")]]), new Map([[unitPath, await currentUnit()]]))

    expect(await systemd(setup).refreshUnit()).toBe(true)

    expect(setup.written).toEqual([])
    expect(setup.commands).toEqual([show, daemonReload])
  })

  test("writes and reloads nothing when the unit file is gone, so Process initiation Off holds through the next update", async () => {
    // Off removes the file before its transient unit stops the service, so a
    // restart of the unit that systemd still holds can reach this refresh.
    const setup = fixture("linux")

    expect(await systemd(setup).refreshUnit()).toBe(false)

    expect(setup.written).toEqual([])
    expect(setup.files.has(unitPath)).toBe(false)
    expect(setup.commands).toEqual([])
  })

  test("writes and reloads nothing for a current, loaded unit", async () => {
    const setup = fixture("linux", new Map([[show.join("\0"), ok("NeedDaemonReload=no\n")]]), new Map([[unitPath, await currentUnit()]]))

    expect(await systemd(setup).refreshUnit()).toBe(false)

    expect(setup.written).toEqual([])
    expect(setup.commands).toEqual([show])
  })
})
