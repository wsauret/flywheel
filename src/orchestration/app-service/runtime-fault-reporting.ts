import type { RuntimeFaultReportOutcome } from "../../protocol/app-service-types.js"

/** A report that was not sent keeps its assembled text for an explicit Copy. */
export type RuntimeFaultReport =
  | Extract<RuntimeFaultReportOutcome, { readonly kind: "sent" }>
  | { readonly kind: "failed" | "not-release"; readonly reportText?: string }
export type RuntimeFaultReporter = (error: Error, projectRoot?: string) => Promise<RuntimeFaultReport | undefined>

/** Publish fault state immediately, then attach one report result per episode.
 * Serving ends an episode. Its retained text is available only by an explicit read.
 * Late results cannot alter a later episode. */
export function createRuntimeFaultReporting<State extends { readonly kind: string; readonly cause?: string; readonly report?: RuntimeFaultReportOutcome }>(options: {
  readonly initial: State
  readonly report?: RuntimeFaultReporter
  readonly publish: (state: State) => void
}) {
  let current = options.initial
  let episode = {}
  let receipt: RuntimeFaultReportOutcome | undefined
  let reportText: string | undefined
  let closed = false
  const pending = new Set<Promise<void>>()
  const withReceipt = (state: State): State => receipt === undefined ? state : { ...state, report: receipt }
  const publish = (next: State): void => {
    if (JSON.stringify(next) === JSON.stringify(current)) return
    current = next
    options.publish(current)
  }
  return {
    state: () => current,
    failedReport: () => reportText,
    update(next: State, error?: Error): void {
      if (closed) return
      const begins = current.kind === "serving" && next.kind !== "serving"
      if (begins || next.kind === "serving") { episode = {}; receipt = undefined; reportText = undefined }
      publish(withReceipt(next))
      if (!begins || next.kind === "serving" || !options.report) return
      const admitted = episode
      const fault = error ?? new Error(next.cause ?? next.kind)
      if (error === undefined) fault.name = next.kind
      const work = Promise.resolve().then(() => options.report?.(fault)).then((result) => {
        if (closed || admitted !== episode) return
        receipt = result?.kind === "sent" ? { kind: "sent", reportId: result.reportId } : { kind: result?.kind ?? "failed" }
        reportText = result?.kind === "sent" ? undefined : result?.reportText
        publish(withReceipt(current))
      }, () => {
        if (closed || admitted !== episode) return
        receipt = { kind: "failed" }
        publish(withReceipt(current))
      })
      pending.add(work)
      void work.then(() => pending.delete(work))
    },
    async dispose(): Promise<void> { closed = true; await Promise.all(pending) },
  }
}
