import type { EventStoreRuntime } from "../../../infra/event-store-effect.js"
import type { AsyncEventStateReadSurface } from "../../../infra/event-store-types.js"
import type { AttachChildSessionProjection } from "../../module-seams.js"
import type { WorkflowInterruption } from "../../session/conversation/turn-end-record.js"
import type { WorkflowHosts } from "../../workflow-host/host-collection.js"
import { WorkflowPreflightError, type WorkflowRunner } from "../../workflow-host/runner-types.js"
import { Log } from "../../../infra/log.js"
import { recordBackgroundFailure } from "../../../infra/operation-log.js"
import { workflowRelativeDir } from "../../../infra/paths.js"
import { ensureDirectoryUnder } from "../../../infra/write-file-under.js"
import { writeOwnerPid, removeOwnerPid } from "../../session/pid-lock.js"

/** Holds each run through preflight, execution, durable acknowledgement, and disposal. */
export function createWorkflowHosts(input: {
  readonly runtime: EventStoreRuntime
  readonly projectionReader: AsyncEventStateReadSurface
  readonly attachChildProjection: AttachChildSessionProjection
}): WorkflowHosts {
  const hosts = new Map<string, WorkflowRunner>()
  const pending = new Map<string, Promise<void>>()
  const log = Log.create({ service: "workflow-hosts" })
  const settlements = new Map<string, Promise<void>>()
  const closing = new Map<string, Promise<void>>()
  let disposed = false
  const listeners = new Set<() => void>()
  const changed = () => { for (const listener of listeners) listener() }
  async function remove(id: string, cause: WorkflowInterruption): Promise<void> {
    const existing = closing.get(id)
    if (existing) return existing
    if (!hosts.has(id) && !pending.has(id)) return
    const close = (async () => {
      await pending.get(id)
      const host = hosts.get(id)
      if (!host) return
      try { await host.abort(cause); await settlements.get(id) } finally {
        try { await host.dispose() } finally { hosts.delete(id); changed() }
      }
    })()
    closing.set(id, close)
    try { await close } finally { closing.delete(id) }
  }
  return {
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async start(options) {
      const id = options.sessionId
      if (disposed) throw new Error("Workflow host collection is closed")
      if (pending.has(id) || hosts.has(id) || closing.has(id)) throw new Error(`Workflow ${id} already has a live or draining host`)
      const prepared = Promise.withResolvers<void>()
      pending.set(id, prepared.promise)
      changed()
      let runner: WorkflowRunner | undefined
      let started = false
      try {
        ensureDirectoryUnder(options.projectRoot, workflowRelativeDir(id))
        writeOwnerPid(id, options.projectRoot, "workflow")
        const { createWorkflowRunner } = await import("../../workflow-host/runner.js")
        const onCoreCompleted = options.onCoreCompleted
        const created = createWorkflowRunner({
          ...options, runtime: input.runtime, projectionReader: input.projectionReader,
          attachChildProjection: input.attachChildProjection,
          onCoreCompleted: onCoreCompleted ? (result) => onCoreCompleted(id, result) : undefined,
        })
        runner = created
        const failure = await runner.prepare()
        if (failure) throw new WorkflowPreflightError(failure)
        if (disposed || closing.has(id)) throw new Error(`Workflow ${id} was released during preparation`)
        await options.onPrepared?.(await runner.readQueue())
        hosts.set(id, runner)
        started = true
        const settlement = runner.run().then(
          (result) => options.onRunnerDone?.(id, result),
          (error: unknown) => options.onRunnerError?.(id, error),
        ).finally(async () => {
          try { await created.dispose() } finally {
            removeOwnerPid(id, options.projectRoot, "workflow")
            hosts.delete(id); settlements.delete(id); changed()
          }
        })
        settlements.set(id, settlement)
        // The launch callback owns reporting. Disposal joins this same promise.
        void settlement.catch((error: unknown) => { recordBackgroundFailure(log, "workflow host settlement", { workflowId: id }, error) })
        return id
      } finally {
        try { if (!started) await runner?.dispose() } finally {
          if (!started) removeOwnerPid(id, options.projectRoot, "workflow")
          pending.delete(id); prepared.resolve(); changed()
        }
      }
    },
    get: (id) => hosts.get(id),
    allIds: () => [...new Set([...hosts.keys(), ...pending.keys()])],
    isRunning: (id) => hosts.has(id),
    async abort(id, by) {
      if (!hosts.has(id)) return false
      await remove(id, by)
      return true
    },
    remove,
    async refreshDeps() { await Promise.all([...hosts.values()].map((host) => host.refreshDeps?.())) },
    async disposeAll(causeOf) {
      disposed = true
      const results = await Promise.allSettled([...new Set([...hosts.keys(), ...pending.keys()])].map((id) => remove(id, causeOf(id))))
      const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, "Workflow host disposal failed")
    },
  }
}
