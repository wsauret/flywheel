import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

import { launchdPlist, registrationFingerprint } from "../../../src/orchestration/app-service/account-service-registration.js"
import type { LaunchdReloadJobConfig } from "./_launchd-reload-job.js"

/** The real launchd re-registration and Process initiation Off sequences,
 *  and what launchd does with a registration's error output and exit codes,
 *  run against one fixed pair of throwaway labels and a plist under a
 *  temporary directory, so the user's own service is never touched. They
 *  load real launchd jobs in the login session, so they run only when
 *  FLYWHEEL_LAUNCHD_INTEGRATION=1 asks for them. launchd can keep state for
 *  a label after the test removes the job; the fixed labels keep that state
 *  to two labels across runs. */
const enabled = process.platform === "darwin" && process.env.FLYWHEEL_LAUNCHD_INTEGRATION === "1"
const JOB_SOURCE = resolve(import.meta.dir, "_launchd-reload-job.ts")
const ERROR_LOG_JOB_SOURCE = resolve(import.meta.dir, "_launchd-error-log-job.ts")
const LABELS = { service: "sh.flywl.test.registration-reload", helper: "sh.flywl.test.registration-reload.helper" } as const
/** How long cleanup waits for launchd to let go of both labels. */
const CLEANUP_BOUND_MS = 15_000

async function command(argv: readonly string[]): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { exitCode, stdout, stderr }
}

const launchctl = (...args: string[]) => command(["/bin/launchctl", ...args])

async function until(what: string, check: () => boolean | Promise<boolean>, timeoutMs: number, describeState: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${timeoutMs / 1_000} seconds\n${describeState()}`)
    await Bun.sleep(250)
  }
}

/** One throwaway job: its launchd domain, its plist, and the markers its
 *  program writes. */
interface ThrowawayJob {
  readonly domain: string
  readonly plist: string
  readonly accountHome: string
  readonly root: string
  /** The file the job's definition names as its StandardErrorPath. */
  readonly errorLog: string
  readonly config: LaunchdReloadJobConfig
  readonly events: () => string[]
  readonly state: () => string
  readonly loaded: (label: string) => Promise<boolean>
  /** The job's definition, which differs by its working directory alone. */
  readonly definition: (workingDirectory: string) => string
  /** Bundles a job program into the temporary root and returns its path. */
  readonly bundle: (source: string) => Promise<string>
  /** Writes `definition` as the plist and loads it. */
  readonly load: (definition: string) => Promise<void>
}

/** Runs `use` with a fresh throwaway job, then removes both labels and the
 *  temporary root, and fails when launchd still holds a label. */
async function withThrowawayJob(use: (job: ThrowawayJob) => Promise<void>): Promise<void> {
  const domain = `gui/${process.getuid?.() ?? 501}`
  const loaded = async (label: string): Promise<boolean> => (await launchctl("print", `${domain}/${label}`)).exitCode === 0
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fw-launchd-reload-")))
  const accountHome = join(root, "home")
  const markers = join(root, "markers")
  const executable = join(root, "flywheel")
  const configPath = join(root, "config.json")
  const plist = join(accountHome, "Library", "LaunchAgents", `${LABELS.service}.plist`)
  const errorLog = join(root, "serve.stderr.log")
  const events = (): string[] => existsSync(join(markers, "events.log")) ? readFileSync(join(markers, "events.log"), "utf8").trim().split("\n") : []
  mkdirSync(markers, { recursive: true })
  const config: LaunchdReloadJobConfig = { accountHome, serveDirectory: join(root, "serve"), markers, executable, labels: LABELS }
  writeFileSync(configPath, JSON.stringify(config))

  // A job program is bundled into the temporary root before anything loads,
  // so no launchd job reads a file under the checkout.
  const bundle = async (source: string): Promise<string> => {
    const outfile = join(root, `${basename(source, ".ts")}.js`)
    const built = await command([process.execPath, "build", "--target=bun", "--outfile", outfile, source])
    if (built.exitCode !== 0) throw new Error(`the job program did not build: ${built.stderr}`)
    return outfile
  }

  let failure: unknown
  try {
    const jobProgram = await bundle(JOB_SOURCE)
    // The helper runs `"$0" serve reload-registration` with $0 this command,
    // as it runs the installed flywheel.
    writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${jobProgram}" "${configPath}" "$@"\n`)
    chmodSync(executable, 0o755)
    mkdirSync(join(accountHome, "Library", "LaunchAgents"), { recursive: true })
    await use({
      domain,
      plist,
      accountHome,
      root,
      errorLog,
      config,
      events,
      state: () => `events:\n${events().join("\n")}`,
      loaded,
      definition: (workingDirectory) => launchdPlist(LABELS.service, [executable, "serve"], workingDirectory, errorLog),
      bundle,
      async load(definition) {
        writeFileSync(plist, definition)
        const bootstrapped = await launchctl("bootstrap", domain, plist)
        if (bootstrapped.exitCode !== 0) throw new Error(`the definition did not load: ${bootstrapped.stderr}`)
      },
    })
  } catch (error) {
    failure = error
  }

  // The helper goes first, so it cannot load the service again meanwhile.
  await launchctl("remove", LABELS.helper)
  await launchctl("bootout", `${domain}/${LABELS.service}`)
  const deadline = Date.now() + CLEANUP_BOUND_MS
  let leftovers: string[] = [LABELS.helper, LABELS.service]
  while (leftovers.length > 0 && Date.now() < deadline) {
    await Bun.sleep(250)
    const answers = await Promise.all(leftovers.map(async (label) => [label, await loaded(label)] as const))
    leftovers = answers.filter(([, stillLoaded]) => stillLoaded).map(([label]) => label)
  }
  rmSync(root, { recursive: true, force: true })
  const report = leftovers.length === 0 ? "" : `launchd still holds ${leftovers.join(" and ")} after cleanup`
  if (failure !== undefined) throw report === "" ? failure : new AggregateError([failure], report)
  expect(report).toBe("")
}

describe.skipIf(!enabled)("launchd registration against a throwaway job", () => {
  test("a stale job hands its reload to a helper outside its tree, which loads the new definition and removes itself", async () => {
    await withThrowawayJob(async (job) => {
      // Two definitions of one job that differ only in their working directory.
      const stale = job.definition(job.root)
      const current = job.definition(job.accountHome)
      const staleFingerprint = registrationFingerprint(stale)
      const currentFingerprint = registrationFingerprint(current)
      expect(staleFingerprint).toBeDefined()
      expect(currentFingerprint).toBeDefined()
      expect(currentFingerprint).not.toBe(staleFingerprint)

      await job.load(stale)
      await until("the stale job serving", () => job.events().includes(`serving ${staleFingerprint}`), 30_000, job.state)

      // An install writes the new definition beside the running job. Its
      // build tick retires it with the code KeepAlive restarts, and the
      // restarted job, still under the stale definition, hands the reload to
      // a helper and parks.
      writeFileSync(job.plist, current)
      await until("the stale job retiring", () => job.events().includes(`retiring ${staleFingerprint}`), 30_000, job.state)
      await until("the restarted stale job handing off", () => job.events().includes(`park ${staleFingerprint}`), 60_000, job.state)

      // The helper runs the real reload as its own launchd job, boots the
      // stale job out, and bootstraps the new definition, which starts.
      await until("the new definition serving", () => job.events().includes(`serving ${currentFingerprint}`), 120_000, job.state)
      expect(job.events()).toContain("helper-started")
      expect(job.events()).toContain("helper-in-flight true")
      expect(job.events()).toContain("helper-reloaded")
      expect(job.events().filter((event) => event.startsWith("failed"))).toEqual([])
      // The tick that requested the replacement proved the login home, so
      // the restart it caused asks nothing, and a healthy start asks nothing.
      expect(job.events()).toContain(`login-home-asked 0 at park ${staleFingerprint}`)
      expect(job.events()).toContain(`login-home-asked 0 at serve ${currentFingerprint}`)
      const printed = await launchctl("print", `${job.domain}/${LABELS.service}`)
      expect(printed.stdout).toContain(`FLYWHEEL_SERVICE_REGISTRATION => ${currentFingerprint}`)
      expect(printed.stdout).toMatch(/spawn type = interactive\b/)

      // The helper removed itself once its reload exited.
      await until("the helper removing itself", async () => !(await job.loaded(LABELS.helper)), 30_000, job.state)
      // It left the one attempt for the fingerprint it applied on record.
      expect(JSON.parse(readFileSync(join(job.config.serveDirectory, "registration-reload.json"), "utf8"))).toEqual({ fingerprint: currentFingerprint, outcome: "reloaded" })
    })
  }, 300_000)

  test("Off run inside the job's own tree returns, and a helper outside the tree unloads the job and removes itself", async () => {
    await withThrowawayJob(async (job) => {
      const definition = job.definition(job.accountHome)
      const fingerprint = registrationFingerprint(definition)
      await job.load(definition)
      await until("the job serving", () => job.events().includes(`serving ${fingerprint}`), 30_000, job.state)

      writeFileSync(join(job.config.markers, "off-request"), "")
      await until("the job receiving SIGTERM", () => job.events().includes(`sigterm ${fingerprint}`), 60_000, job.state)
      // Off returned inside the job before the stop reached it, so no step
      // of Off depended on the process the stop ends.
      const events = job.events()
      expect(events).toContain(`off-returned ${fingerprint}`)
      expect(events.indexOf(`off-returned ${fingerprint}`)).toBeLessThan(events.indexOf(`sigterm ${fingerprint}`))
      expect(existsSync(job.plist)).toBe(false)

      const released = async (): Promise<boolean> => !(await job.loaded(LABELS.service)) && !(await job.loaded(LABELS.helper))
      await until("launchd releasing both labels", released, 30_000, job.state)
      expect(job.events()).toContain("helper-reloaded")
      expect(job.events().filter((event) => event.startsWith("failed"))).toEqual([])
      // Nothing loads or starts the job again.
      await Bun.sleep(15_000)
      expect(await released()).toBe(true)
    })
  }, 300_000)

  test("a failing start's error output stays in StandardErrorPath, which the start bounds, and a start that exits 0 stays stopped until a kickstart", async () => {
    await withThrowawayJob(async (job) => {
      const program = await job.bundle(ERROR_LOG_JOB_SOURCE)
      const errorOutput = (): Buffer => existsSync(job.errorLog) ? readFileSync(job.errorLog) : Buffer.alloc(0)
      const starts = (): number => job.events().filter((event) => event === "start").length
      const running = async (): Promise<boolean> => (await launchctl("print", `${job.domain}/${LABELS.service}`)).stdout.includes("state = running")
      // An error log past the bound, as a long run of failed starts leaves it.
      writeFileSync(job.errorLog, Buffer.alloc(1_536 * 1024, "x"))

      await job.load(launchdPlist(LABELS.service, [process.execPath, program, job.errorLog, job.config.markers], job.accountHome, job.errorLog))
      // KeepAlive restarts the failing start, and launchd appends each
      // start's output. The first start kept the last 256 KiB in place, and
      // its own output followed that tail, so launchd writes at the end.
      await until("two failed starts", () => errorOutput().includes("start 2\n"), 60_000, job.state)
      const expected = Buffer.concat([Buffer.alloc(256 * 1024, "x"), Buffer.from("start 1\nstart 2\n")])
      expect(errorOutput().subarray(0, expected.length)).toEqual(expected)

      // A start that exits 0 parks the job: launchd starts it again only on request.
      writeFileSync(join(job.config.markers, "succeed"), "")
      await until("a start that exits 0", async () => job.events().includes("exit 0") && !(await running()), 60_000, job.state)
      const parkedAt = starts()
      await Bun.sleep(15_000)
      expect(starts()).toBe(parkedAt)
      expect(await running()).toBe(false)

      const kicked = await launchctl("kickstart", `${job.domain}/${LABELS.service}`)
      expect(kicked.exitCode).toBe(0)
      await until("the requested start", () => starts() === parkedAt + 1, 30_000, job.state)
    })
  }, 300_000)
})
