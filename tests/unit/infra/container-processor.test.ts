import { describe, expect, it } from "bun:test"

import { containerProcessor, posixProcessorPlatform, windowsProcessorPlatform } from "../../../src/infra/container-processor.js"
import type { ContainerProbe } from "../../../src/infra/process-container.js"
import type { WindowsJobApi } from "../../../src/infra/windows-job-object.js"

/** A stat line in the given group. */
function stat(pid: number, pgid: number): string {
  // pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime ... threads(20) ... starttime(22)
  return `${pid} (job) R 1 ${pgid} ${pgid} 0 0 0 0 0 0 0 0 0 0 0 20 0 1 0 100`
}

function procfsProbe(table: Map<number, string>): ContainerProbe {
  return {
    signal: () => undefined,
    groupExists: () => true,
    procfs: {
      listPids: () => [...table.keys()],
      readStat: (pid) => {
        const text = table.get(pid)
        return text === undefined ? { kind: "absent" } : { kind: "content", text }
      },
      readEnviron: () => ({ kind: "unreadable" }),
      bootId: () => ({ kind: "unreadable" }),
    },
  }
}

describe("container processor", () => {
  it("counts the runnable threads of each group's members", () => {
    const table = new Map([[10, stat(10, 10)], [11, stat(11, 10)], [12, stat(12, 10)], [20, stat(20, 20)], [30, stat(30, 99)]])
    const runnable = new Map([[10, 0], [11, 4], [12, 1], [20, 2], [30, 8]])
    const reader = containerProcessor(posixProcessorPlatform(procfsProbe(table), undefined, (pid) => runnable.get(pid) ?? 0))
    expect(reader.demand([{ pid: 10, token: "a" }, { pid: 20, token: "b" }])).toEqual(new Map([["a", 5], ["b", 2]]))
  })

  it("holds every member except the supervisor, including a child started during the hold", () => {
    const table = new Map([[10, stat(10, 10)], [11, stat(11, 10)]])
    const signals: string[] = []
    const reader = containerProcessor(posixProcessorPlatform(procfsProbe(table), (pid, name) => {
      signals.push(`${name} ${pid}`)
      if (pid === 11 && name === "SIGSTOP") table.set(12, stat(12, 10))
      return true
    }))
    expect(reader.hold({ pid: 10, token: "a" })).toBe(true)
    expect(signals).toEqual(["SIGSTOP 11", "SIGSTOP 12"])
    reader.release({ pid: 10, token: "a" })
    expect(signals.at(-1)).toBe("SIGCONT -10")
  })

  it("resumes what it stopped when the members keep changing", () => {
    let next = 11
    const table = new Map([[10, stat(10, 10)], [11, stat(11, 10)]])
    const signals: string[] = []
    const reader = containerProcessor(posixProcessorPlatform(procfsProbe(table), (pid, name) => {
      signals.push(`${name} ${pid}`)
      if (name === "SIGSTOP") table.set(++next, stat(next, 10))
      return true
    }))
    expect(reader.hold({ pid: 10, token: "a" })).toBe(false)
    expect(signals.at(-1)).toBe("SIGCONT -10")
  })

  it("does not hold a container with a member it cannot stop, and continues what it stopped", () => {
    const table = new Map([[10, stat(10, 10)], [11, stat(11, 10)], [12, stat(12, 10)]])
    const signals: string[] = []
    const reader = containerProcessor(posixProcessorPlatform(procfsProbe(table), (pid, name) => {
      signals.push(`${name} ${pid}`)
      return pid !== 12
    }))
    expect(reader.hold({ pid: 10, token: "a" })).toBe(false)
    expect(signals).toEqual(["SIGSTOP 11", "SIGSTOP 12", "SIGCONT -10"])
  })

  it("continues a container it never held, which undoes a hold an earlier reader left", () => {
    const table = new Map([[10, stat(10, 10)], [11, stat(11, 10)]])
    const signals: string[] = []
    const reader = containerProcessor(posixProcessorPlatform(procfsProbe(table), (pid, name) => { signals.push(`${name} ${pid}`); return true }))
    reader.release({ pid: 10, token: "a" })
    expect(signals).toEqual(["SIGCONT -10"])
  })

  it("sums a Windows job's members from one system snapshot and suspends and resumes each member except the supervisor", () => {
    const calls: string[] = []
    const members = [10, 11, 12]
    const jobs: WindowsJobApi = {
      create: () => undefined,
      open: (name) => {
        calls.push(`open ${name}`)
        return {
          kind: "opened",
          job: {
            admit: () => true, letChildrenLeave: () => true, terminate: () => undefined, close: () => { calls.push(`close ${name}`) },
            pids: () => members,
            suspend: (pid) => { calls.push(`suspend ${pid}`); return true },
            resume: (pid) => { calls.push(`resume ${pid}`); return true },
          },
        }
      },
    }
    let snapshots = 0
    const processes = { runnableThreads: () => { snapshots += 1; return new Map([[11, 3], [12, 1], [99, 6]]) } }
    const reader = containerProcessor(windowsProcessorPlatform(jobs, processes))
    const container = { pid: 10, token: "t" }
    expect(reader.demand([container, { pid: 20, token: "u" }])).toEqual(new Map([["t", 4], ["u", 4]]))
    expect(snapshots).toBe(1)
    expect(reader.hold(container)).toBe(true)
    reader.release(container)
    expect(calls.filter((call) => call.startsWith("suspend") || call.startsWith("resume"))).toEqual(["suspend 11", "suspend 12", "resume 11", "resume 12"])
    // Every open is closed again, so no handle here keeps the job alive.
    expect(calls.filter((call) => call.startsWith("close")).length).toBe(calls.filter((call) => call.startsWith("open")).length)
  })
})
