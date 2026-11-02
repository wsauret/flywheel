import { expect, test } from "bun:test"

/** The account service's registrations set no open-file limit,
 *  because the runtime raises its own soft limit when it starts and every
 *  process it launches inherits the raised limit. launchd starts a job with a
 *  soft limit of 256, so this starts the runtime under that limit and reads the
 *  limits of a process the runtime launches. */

/** The runtime raises its soft limit to its hard limit, but never above this
 *  cap, as Node does: macOS gives a job no hard limit, and a soft limit near
 *  INT_MAX breaks a child that reads the limit into an int. */
const RUNTIME_RAISE_CAP = 1 << 20

/** Prints the soft and then the hard open-file limit of a process that the
 *  runtime under test launches, one on each line. */
const CHILD_LIMITS = `console.log(await new Response(Bun.spawn(["/bin/sh", "-c", "ulimit -Sn; ulimit -Hn"], { stdout: "pipe", windowsHide: true }).stdout).text())`

test.skipIf(process.platform === "win32")("a process the runtime launches under launchd's default soft limit of 256 open files inherits the runtime's raised limit", async () => {
  const runtime = Bun.spawn(["/bin/sh", "-c", `ulimit -Sn 256 && exec "$0" -e "$1"`, process.execPath, CHILD_LIMITS], { stdout: "pipe", stderr: "inherit", windowsHide: true })
  const [output, exitCode] = await Promise.all([new Response(runtime.stdout).text(), runtime.exited])
  expect(exitCode).toBe(0)

  const [soft, hard] = output.trim().split("\n")
  expect(Number(soft)).toBe(hard === "unlimited" ? RUNTIME_RAISE_CAP : Math.min(Number(hard), RUNTIME_RAISE_CAP))
}, 30_000)
