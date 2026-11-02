/** The program of the throwaway launchd job that
 *  launchd-registration-reload.test.ts registers. The test bundles it into
 *  its temporary root before any job loads, so launchd never runs a file
 *  from the checkout. launchd runs it as the service (`serve`) and as the
 *  reload helper (`serve reload-registration`), and it runs the real
 *  registration refresh, reload, and Process initiation Off code with the
 *  test's labels. It reports what it did as marker lines, because launchd
 *  gives a job no terminal. A serving job turns Process initiation off from
 *  inside its own tree when the test writes the `off-request` marker file.
 *
 *  argv: <config.json> serve [reload-registration] */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { accountServiceRegistrationControl, createAccountServiceInstallation, reloadLaunchdRegistration, type AccountServicePlatform } from "../../../src/orchestration/app-service/account-service-installation.js"
import { REGISTRATION_FINGERPRINT_ENV } from "../../../src/orchestration/app-service/account-service-registration.js"
import { createServiceRegistrationRefresh, registrationReloadGuard } from "../../../src/orchestration/app-service/service-registration-refresh.js"

export interface LaunchdReloadJobConfig {
  readonly accountHome: string
  readonly serveDirectory: string
  readonly markers: string
  readonly executable: string
  readonly labels: AccountServicePlatform["launchdLabels"]
}

/** Exit 75 is the account service's retirement code, which KeepAlive restarts. */
const RETIRE_EXIT = 75

const [configPath, operation, ...rest] = process.argv.slice(2)
if (configPath === undefined || operation !== "serve") throw new Error("usage: _launchd-reload-job.ts <config.json> serve [reload-registration]")
const config: LaunchdReloadJobConfig = JSON.parse(readFileSync(configPath, "utf8"))
const mark = (line: string): void => { appendFileSync(join(config.markers, "events.log"), `${line}\n`) }

const platform: AccountServicePlatform = {
  platform: "darwin",
  accountHome: config.accountHome,
  loginHome: () => config.accountHome,
  env: process.env,
  uid: process.getuid?.(),
  executable: config.executable,
  launcher: undefined,
  launchdLabels: config.labels,
  retired: [],
  runCommand: async (command) => {
    const child = Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { exitCode, stdout, stderr }
  },
  sleep: Bun.sleep,
  now: Date.now,
  files: {
    exists: existsSync,
    read: (path) => existsSync(path) ? readFileSync(path, "utf8") : undefined,
    write: (path, contents) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents) },
    remove: (path) => { rmSync(path, { force: true }) },
    installBundle: () => { throw new Error("the throwaway job runs no launcher bundle") },
    withPrivateFile: () => { throw new Error("the throwaway job stages no private file") },
  },
}
const control = accountServiceRegistrationControl(platform)

try {
  if (rest[0] === "reload-registration") {
    mark("helper-started")
    // The helper is its own launchd job, so a start that asks now finds it.
    mark(`helper-in-flight ${String(await control.launchd?.reloadInFlight())}`)
    const guard = registrationReloadGuard(config.serveDirectory)
    await reloadLaunchdRegistration(platform, { parentPid: process.ppid }, (outcome) => guard.record(outcome))
    mark("helper-reloaded")
  } else {
    const own = process.env[REGISTRATION_FINGERPRINT_ENV] ?? ""
    // launchd ends a job it boots out with SIGTERM.
    process.on("SIGTERM", () => {
      mark(`sigterm ${own}`)
      process.exit(0)
    })
    let loginHomeAsked = 0
    // launchd runs the job's program directly, so launchd is its parent and
    // proves the start without a launcher. The job's account home is its
    // test's, which the account database never names as the login home, so
    // the job proves its own login home to exercise the refresh.
    const refresh = createServiceRegistrationRefresh({
      platform: process.platform,
      scheduledTask: false,
      launcherExecutable: "",
      executableOf: () => ({ kind: "absent" }),
      procEntry: () => undefined,
      uid: process.getuid?.(),
      isLoginHome: async () => {
        loginHomeAsked++
        return true
      },
      env: { ...process.env },
      pid: process.pid,
      ppid: process.ppid,
      serveDirectory: config.serveDirectory,
      launchdLabel: config.labels.service,
      control: () => control,
    })
    const decision = await refresh.atStart()
    mark(`login-home-asked ${loginHomeAsked} at ${decision} ${own}`)
    if (decision !== "serve") {
      mark(`${decision} ${own}`)
      process.exit(decision === "park" ? 0 : RETIRE_EXIT)
    }
    mark(`serving ${own}`)
    const offRequest = join(config.markers, "off-request")
    // The build tick, fast: a registration that changed on disk retires the
    // service with the code its manager restarts.
    for (;;) {
      await Bun.sleep(250)
      if (existsSync(offRequest)) {
        rmSync(offRequest)
        await createAccountServiceInstallation(() => platform).uninstall()
        mark(`off-returned ${own}`)
      }
      if (await refresh.atBuildTick()) {
        mark(`retiring ${own}`)
        process.exit(RETIRE_EXIT)
      }
    }
  }
} catch (error) {
  mark(`failed ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
