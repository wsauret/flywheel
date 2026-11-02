import { afterEach, describe, expect, test } from "bun:test"

import { darwinProcess } from "../../../src/infra/darwin-process-api.js"
import { emptyContainers, unixContainer, unixContainerIdentity } from "../../../src/infra/process-container.js"

/** A pid no process holds: macOS pids stay far below it. */
const FREE_PID = 2_000_000_000

const leaders: number[] = []

afterEach(() => {
  for (const pid of leaders.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      // The group already ended.
    }
  }
})

/** Starts `script` as the leader of a fresh process group, as an owned launch
 *  starts its supervisor. */
function group(script: string): number {
  const child = Bun.spawn(["/bin/sh", "-c", script], { detached: true, stdio: ["ignore", "ignore", "ignore"], windowsHide: true })
  leaders.push(child.pid)
  return child.pid
}

async function until<T>(read: () => T, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 2_000
  for (;;) {
    const value = read()
    if (done(value) || Date.now() > deadline) return value
    await Bun.sleep(10)
  }
}

describe.skipIf(process.platform !== "darwin")("macOS process facts from libproc", () => {
  test("identifies a group leader by pid, group and the kernel's unique id, the same on every read", () => {
    const leader = group("exec sleep 5")

    const query = darwinProcess.query(leader)

    expect(query).toMatchObject({ kind: "process", pgid: leader })
    expect(query.kind === "process" ? query.identity : "").toMatch(new RegExp(`^${leader} ${leader} \\d+$`))
    expect(darwinProcess.query(leader)).toEqual(query)
    expect(unixContainerIdentity(leader)).toEqual({ kind: "container", identity: query.kind === "process" ? query.identity : "" })
  })

  test("gives two processes started one after the other different identities", () => {
    // The unique id is the identity's third field. The kernel counts it up
    // for each new process, so a later process holds a greater one.
    const uniqueId = (pid: number): bigint => {
      const query = darwinProcess.query(pid)
      if (query.kind !== "process") throw new Error(`pid ${pid} read as ${query.kind}`)
      return BigInt(query.identity.split(" ")[2] ?? "")
    }
    const first = uniqueId(group("exec sleep 5"))
    const second = uniqueId(group("exec sleep 5"))
    const self = uniqueId(process.pid)

    expect(first).not.toBe(0n)
    expect(second).toBeGreaterThan(first)
    expect(first).not.toBe(self)
    expect(second).not.toBe(self)
  })

  test("reads a free pid as absent and another user's process as present", () => {
    expect(darwinProcess.query(FREE_PID)).toEqual({ kind: "absent" })
    // launchd runs as root, and both calls answer for a process of any user.
    expect(darwinProcess.query(1)).toMatchObject({ kind: "process", pgid: 1 })
  })

  test("names the host boot as sysctl reports kern.bootsessionuuid", () => {
    const reported = Bun.spawnSync(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true }).stdout.toString().trim()

    expect(reported).toMatch(/^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/)
    expect(darwinProcess.bootSession()).toEqual({ kind: "boot", id: reported.replaceAll("-", "").toLowerCase() })
  })

  test("lists every member of a spawned process group", async () => {
    const leader = group("sleep 5 & sleep 5 & wait")

    const members = await until(() => darwinProcess.group(leader), (listed) => (listed?.length ?? 0) >= 3)

    expect(members).toHaveLength(3)
    expect(members).toContain(leader)
    expect(unixContainer(leader).populated()).toBe(true)
  })

  test("lists an unreaped member but never counts it as holding the container", async () => {
    // The inner shell exits at once and its parent execs into `sleep`, which
    // never reaps it, so the group keeps one zombie beside one running member.
    const leader = group("/bin/sh -c 'exit 0' & exec sleep 5")

    const members = await until(() => darwinProcess.group(leader), (listed) => listed?.some((pid) => pid !== leader && darwinProcess.query(pid).kind === "absent") === true)
    const zombie = members?.find((pid) => pid !== leader)

    expect(members).toHaveLength(2)
    expect(zombie === undefined ? undefined : darwinProcess.query(zombie)).toEqual({ kind: "absent" })
    expect(unixContainer(leader).populated()).toBe(true)
    process.kill(leader, "SIGKILL")
    expect(await until(() => unixContainer(leader).populated(), (populated) => !populated)).toBe(false)
  })

  test("ends a real group with TERM through the group and proves it empty", async () => {
    const leader = group("sleep 5 & sleep 5 & wait")
    await until(() => darwinProcess.group(leader), (listed) => (listed?.length ?? 0) >= 3)

    const settlement = await emptyContainers([unixContainer(leader)], 2_000, (ms) => Bun.sleep(ms), { reason: "test" })

    // The kernel can still list members that exited and wait to be reaped, but
    // none of them runs.
    expect(settlement).toEqual({ kind: "empty" })
    expect((darwinProcess.group(leader) ?? []).map((pid) => darwinProcess.query(pid).kind).filter((kind) => kind !== "absent")).toEqual([])
  })
})
