/**
 * Wall-clock accounting for the release performance suite. Every gate phase,
 * scenario, rep, and in-rep step runs through `time()`, which prints the
 * duration as the step finishes and keeps it for the end-of-run summary, so a
 * slow suite shows exactly where its minutes go.
 */

export interface TimelineEntry {
  /** Slash-separated path, for example `candidate/startup-empty/rep1/ready`. */
  readonly label: string
  readonly startedAtMs: number
  readonly durationMs: number
}

export interface Timeline {
  /** Runs one step under a label and records how long it took, even when it throws. */
  time<T>(label: string, work: () => Promise<T> | T): Promise<T>
  /** A timeline whose labels are nested under `prefix`. */
  scope(prefix: string): Timeline
  entries(): readonly TimelineEntry[]
  /** Entries as a nested text table, longest phases legible at a glance. */
  summary(): string
}

export function createTimeline(print: (line: string) => void = console.log, prefix = "", entries: TimelineEntry[] = [], origin = performance.now()): Timeline {
  const qualify = (label: string) => (prefix ? `${prefix}/${label}` : label)
  return {
    async time(label, work) {
      const qualified = qualify(label)
      const startedAt = performance.now()
      try {
        return await work()
      } finally {
        const durationMs = performance.now() - startedAt
        entries.push({ label: qualified, startedAtMs: startedAt - origin, durationMs })
        print(`[timing] ${qualified} ${formatMs(durationMs)}`)
      }
    },
    scope: (nested) => createTimeline(print, qualify(nested), entries, origin),
    entries: () => entries,
    summary() {
      const ordered = [...entries].sort((a, b) => a.startedAtMs - b.startedAtMs)
      const width = Math.max(...ordered.map((entry) => entry.label.length), 0)
      return ordered
        .map((entry) => {
          const depth = entry.label.split("/").length - 1
          return `${"  ".repeat(depth)}${entry.label.padEnd(width - depth * 2)}  ${formatMs(entry.durationMs).padStart(9)}`
        })
        .join("\n")
    },
  }
}

function formatMs(ms: number): string {
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}
