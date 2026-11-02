import type { ExperimentCommandResult } from "./experiment-command-runner.js"

/** One command result bound to the exact candidate content measured by it. */
export interface PendingExperimentResult extends ExperimentCommandResult {
  readonly measuredTree: string
  readonly resultTree: string
}

export type ExperimentExecutionSnapshot<Pending> =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly command: string }
  | { readonly status: "pending"; readonly value: Pending }

type Listener<Pending> = (state: ExperimentExecutionSnapshot<Pending>) => void

/** The read side a chat runner exposes to protocol projections: they derive
 *  `running` from this owner and never from tool facts. */
export type ExperimentExecutionView = Pick<ExperimentExecutionState<unknown>, "snapshot" | "subscribe">

/** Session-owned authority for the command currently running and its one unlogged result. */
export class ExperimentExecutionState<Pending = PendingExperimentResult> {
  private current: ExperimentExecutionSnapshot<Pending> = { status: "idle" }
  private readonly listeners = new Set<Listener<Pending>>()

  snapshot(): ExperimentExecutionSnapshot<Pending> {
    return this.current
  }

  subscribe(listener: Listener<Pending>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(command: string): boolean {
    if (this.current.status !== "idle") return false
    this.publish({ status: "running", command })
    return true
  }

  finish(value: Pending): boolean {
    if (this.current.status !== "running") return false
    this.publish({ status: "pending", value })
    return true
  }

  fail(): boolean {
    if (this.current.status !== "running") return false
    this.publish({ status: "idle" })
    return true
  }

  clear(): void {
    if (this.current.status !== "idle") this.publish({ status: "idle" })
  }

  pending(): Pending | undefined {
    return this.current.status === "pending" ? this.current.value : undefined
  }

  private publish(next: ExperimentExecutionSnapshot<Pending>): void {
    this.current = next
    for (const listener of this.listeners) listener(next)
  }
}
