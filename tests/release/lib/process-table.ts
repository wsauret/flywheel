/** Resident memory of one process tree, read the same way on every platform:
 *  `ps` where there is one, and the kernel's own snapshot and working set on
 *  Windows. A scenario that measures memory reads it through here, so two
 *  scenarios never disagree about what a tree's RSS is.
 *
 *  `ps` runs as an awaited child process, never a synchronous one: a scenario
 *  that samples while its loopback servers stream must not hold its own event
 *  loop, or the stream it measures arrives late. */
import { windowsProcessApi } from "../../../src/infra/windows-process-api.js"

/** Longest idle wait before the tree's RSS is taken as settled. */
const IDLE_SETTLE_CEILING_MS = 30_000
const IDLE_SAMPLE_INTERVAL_MS = 1_000

export interface ProcessSample {
  readonly rssMb: number
  readonly evidence: string
}

/** One row of the process table. The resident size is read only for the rows
 *  that turn out to be the tree, because Windows answers it per process and
 *  the table holds hundreds. */
interface ProcessRow {
  readonly pid: number
  readonly ppid: number
  residentKiB(): number
  line(): string
}

/** The whole process table: `ps` where there is one, and the kernel's own
 *  snapshot and working set on Windows, which reports no command line. */
async function processTable(): Promise<readonly ProcessRow[]> {
  if (process.platform === "win32") {
    const api = windowsProcessApi()
    const rows = api?.list()
    if (api === undefined || rows === undefined) throw new Error("the Windows process table could not be read")
    return rows.map((row) => {
      const residentKiB = () => (api.workingSetBytes(row.pid) ?? 0) / 1024
      return { pid: row.pid, ppid: row.parentPid, residentKiB, line: () => `${row.pid} ${row.parentPid} ${Math.round(residentKiB())} (working set)` }
    })
  }
  const ps = Bun.spawn(["ps", "-axo", "pid=,ppid=,rss=,command="], {
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(ps.stdout).text(), new Response(ps.stderr).text(), ps.exited])
  if (exitCode !== 0) throw new Error(`ps failed: ${stderr.trim()}`)
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), residentKiB: () => Number(match[3]), line: () => line }] : []
  })
}

/** The summed resident size of `rootPid` and every descendant. Throws when
 *  the root is gone, because a missing root would read as a tree of zero. */
export async function processSample(rootPid: number): Promise<ProcessSample> {
  const rows = await processTable()
  const selected = new Set<number>([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (selected.has(row.ppid) && !selected.has(row.pid)) {
        selected.add(row.pid)
        changed = true
      }
    }
  }
  const tree = rows.filter((row) => selected.has(row.pid))
  if (!tree.some((row) => row.pid === rootPid)) throw new Error(`process ${rootPid} was absent from the process table`)
  return {
    rssMb: tree.reduce((total, row) => total + row.residentKiB(), 0) / 1024,
    evidence: `${tree.map((row) => row.line()).join("\n")}\n`,
  }
}

/** The tree's idle RSS: the first sample after three consecutive one-second
 *  samples agree within 2 percent, or the sample at the ceiling. Startup
 *  allocations settle within a few seconds, so this reads the same steady
 *  value a fixed 30 second wait did without spending the rest of the wait. */
export async function settledSample(rootPid: number): Promise<ProcessSample> {
  const deadline = performance.now() + IDLE_SETTLE_CEILING_MS
  const recent: ProcessSample[] = []
  for (;;) {
    await Bun.sleep(IDLE_SAMPLE_INTERVAL_MS)
    const sample = await processSample(rootPid)
    recent.push(sample)
    if (recent.length > 3) recent.shift()
    const rss = recent.map((entry) => entry.rssMb)
    const settled = recent.length === 3 && Math.max(...rss) - Math.min(...rss) <= Math.max(...rss) * 0.02
    if (settled || performance.now() >= deadline) return sample
  }
}
