import { randomUUID } from "node:crypto"

import type { PersistentRead, PersistentSpool } from "./persistent-spool.js"
import { launchPersistentSubprocess, type PersistentLaunchData, type PersistentLaunchOptions, type PersistentProcessMetadata, type PersistentSubprocess } from "./persistent-subprocess.js"

interface PersistentProcessRecordBase extends Omit<PersistentProcessMetadata, "status"> {
  readonly id: string
  readonly pid: number
  readonly command: readonly string[]
  readonly spool: PersistentSpool
}

export type PersistentProcessRecord =
  | PersistentProcessRecordBase & { readonly status: "running" }
  | PersistentProcessRecordBase & { readonly status: "exited"; readonly exitCode: number }

export type PersistentStopResult = "terminated" | "already_exited" | "unsettled"

export interface PersistentProcessClient {
  launch(command: readonly string[], options?: PersistentLaunchData): Promise<PersistentProcessRecord>
  list(): Promise<readonly PersistentProcessRecord[]>
  read(id: string, stream: "stdout" | "stderr", offset: number, maxBytes: number): Promise<PersistentRead>
  stop(id: string): Promise<PersistentStopResult>
  release(id: string): Promise<void>
  close(): void
}

export interface PersistentProcessManager {
  client(): PersistentProcessClient
  /** Surrender every process still managed by this CLI host. Idempotent. */
  releaseAll(): void
}

export interface PersistentProcessManagerOptions {
  readonly launch?: (command: readonly string[], options?: PersistentLaunchOptions) => Promise<PersistentSubprocess>
}

/** Owns all managed persistent processes for one CLI host lifetime. Client closure does not change process ownership. */
export function createPersistentProcessManager(options: PersistentProcessManagerOptions = {}): PersistentProcessManager {
  const launch = options.launch ?? launchPersistentSubprocess
  interface ManagedProcess {
    readonly process: PersistentSubprocess
    exitCode?: number
    stopping?: Promise<PersistentStopResult>
  }
  const processes = new Map<string, ManagedProcess>()
  const record = (id: string, managed: ManagedProcess): PersistentProcessRecord => {
    const metadata = managed.process.metadata()
    if (managed.exitCode !== undefined) return { id, pid: managed.process.pid, command: managed.process.command, spool: managed.process.spool, ...metadata, status: "exited", exitCode: managed.exitCode }
    return { id, pid: managed.process.pid, command: managed.process.command, spool: managed.process.spool, ...metadata, status: "running" }
  }
  const requireProcess = (id: string): ManagedProcess => {
    const managed = processes.get(id)
    if (!managed) throw new Error(`unknown persistent process: ${id}`)
    return managed
  }

  const releaseAll = (): void => {
    for (const managed of processes.values()) managed.process.release()
    processes.clear()
  }
  return {
    client() {
      let closed = false
      const open = (): void => {
        if (closed) throw new Error("persistent process client is closed")
      }
      return {
        async launch(command, launchOptions) {
          open()
          const process = await launch(command, launchOptions)
          const id = `persistent:${randomUUID()}`
          const managed: ManagedProcess = { process }
          processes.set(id, managed)
          void process.exited.then((exitCode) => { managed.exitCode = exitCode })
          return record(id, managed)
        },
        async list() {
          open()
          return [...processes].map(([id, managed]) => record(id, managed))
        },
        async read(id, stream, offset, maxBytes) {
          open()
          return requireProcess(id).process.read(stream, offset, maxBytes)
        },
        async stop(id) {
          open()
          const managed = requireProcess(id)
          if (managed.stopping) return await managed.stopping
          const wasExited = managed.process.metadata().status === "exited"
          const stopping: Promise<PersistentStopResult> = managed.process.stop().then(
            (outcome): PersistentStopResult => outcome === "unsettled" ? "unsettled" : wasExited ? "already_exited" : "terminated",
            (error): PersistentStopResult => {
              if (managed.process.metadata().status === "exited") return "already_exited"
              throw error
            },
          )
          managed.stopping = stopping
          void stopping.then(
            () => { if (managed.stopping === stopping) managed.stopping = undefined },
            () => { if (managed.stopping === stopping) managed.stopping = undefined },
          )
          return await stopping
        },
        async release(id) {
          open()
          const managed = requireProcess(id)
          if (managed.stopping) await managed.stopping
          managed.process.release()
          processes.delete(id)
        },
        close() { closed = true },
      }
    },
    releaseAll,
  }
}