import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { sourceCheckout } from "../../../../src/infra/cli-subprocess.js"
import { accountServicePlatform, createAccountServiceInstallation } from "../../../../src/orchestration/app-service/account-service-installation.js"
import { SERVICE_NAMES } from "../../../../src/orchestration/app-service/account-service-registration.js"
import { systemdUnitPath } from "../../../../src/orchestration/app-service/account-service-systemd.js"
import { bytesOf, fixture, missing, plistPath, retired, taskXmlPath, textOf } from "./_account-service-fixtures.js"

/** The dev lane registers its own job, which runs the checkout's entry
 *  through Bun, beside the installed lane's job (ARCH-RUNTIME-008, PI-REMOTE-024). */
describe("dev lane registration", () => {
  const devPlatform = (setup: ReturnType<typeof fixture>, command: readonly [string, ...string[]]) => createAccountServiceInstallation(() => ({ ...setup.platform, names: SERVICE_NAMES.dev, command, launcher: undefined, retired: [] }))

  test("a source run's platform names the dev registration, runs the checkout's entry, and retires no earlier registration", () => {
    const platform = accountServicePlatform({ userDataRoot: "/scratch/home/.flywheel", accountHome: "/scratch/home", retired: [retired], runCommand: async () => { throw new Error("building a platform runs no command") } })

    expect(platform?.names).toEqual(SERVICE_NAMES.dev)
    expect(platform?.command).toEqual([process.execPath, "--conditions=browser", join(sourceCheckout(), "scripts", "dev.ts")])
    expect(platform?.launcher).toBeUndefined()
    expect(platform?.retired).toEqual([])
  })

  test("launchd loads the dev job under its own label, runs the checkout through Bun, and installs no launcher bundle", async () => {
    const devPlist = "/scratch/test/Library/LaunchAgents/sh.flywl.flywheel.serve-dev.plist"
    const setup = fixture("darwin", new Map([[["launchctl", "print", "gui/1000/sh.flywl.flywheel.serve-dev"].join("\0"), missing]]))

    await devPlatform(setup, ["/scratch/test/.bun/bin/bun", "--conditions=browser", "/scratch/flywheel/scripts/dev.ts"]).install()

    expect(textOf(setup.files.get(devPlist))).toContain(["    <string>/scratch/test/.bun/bin/bun</string>", "    <string>--conditions=browser</string>", "    <string>/scratch/flywheel/scripts/dev.ts</string>", "    <string>serve</string>"].join("\n"))
    expect(setup.files.has(plistPath)).toBe(false)
    expect(setup.installedBundles).toEqual([])
    expect(setup.commands).toContainEqual(["launchctl", "bootstrap", "gui/1000", devPlist])
    expect(setup.commands.flat().some((word) => word.endsWith("sh.flywl.flywheel.serve"))).toBe(false)
  })

  test("systemd enables the dev unit, whose start line quotes every word of the checkout's entry", async () => {
    const active = ["systemctl", "--user", "is-active", "--quiet", SERVICE_NAMES.dev.systemdUnit]
    const setup = fixture("linux", new Map([[active.join("\0"), missing], [["systemctl", "--user", "is-enabled", "--quiet", SERVICE_NAMES.dev.systemdUnit].join("\0"), missing]]))

    await devPlatform(setup, ["/home/test/.bun/bin/bun", "--conditions=browser", "/home/test/flywheel/scripts/dev.ts"]).install()

    expect(textOf(setup.files.get(systemdUnitPath({ ...setup.platform, names: SERVICE_NAMES.dev })))).toContain(`ExecStart="/home/test/.bun/bin/bun" "--conditions=browser" "/home/test/flywheel/scripts/dev.ts" serve\n`)
    expect(setup.files.has(systemdUnitPath(setup.platform))).toBe(false)
    expect(setup.commands).toContainEqual(["systemctl", "--user", "enable", "--no-reload", "--now", SERVICE_NAMES.dev.systemdUnit])
  })

  test("Task Scheduler creates the dev task, whose action runs Bun with the checkout's entry and quotes a path with a space", async () => {
    const setup = fixture("win32", new Map([[["schtasks", "/Query", "/TN", SERVICE_NAMES.dev.windowsTask, "/XML"].join("\0"), missing]]))

    await devPlatform(setup, ["C:\\Users\\test\\.bun\\bin\\bun.exe", "--conditions=browser", "C:\\Users\\test\\My Code\\flywheel\\scripts\\dev.ts"]).install()

    expect(setup.commands).toContainEqual(["schtasks", "/Create", "/F", "/TN", "Flywheel Serve Dev", "/XML", taskXmlPath])
    const xml = Buffer.from(bytesOf(setup.written.find(([path]) => path === taskXmlPath)?.[1]).slice(2)).toString("utf16le")
    expect(xml).toContain("<Command>C:\\Users\\test\\.bun\\bin\\bun.exe</Command>")
    expect(xml).toContain("<Arguments>--conditions=browser &quot;C:\\Users\\test\\My Code\\flywheel\\scripts\\dev.ts&quot; serve --scheduled-task</Arguments>")
    expect(setup.commands.flat()).not.toContain("Flywheel Serve")
  })
})
