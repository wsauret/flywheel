import type { WorkflowView } from "../../workflows/view/types.js"
import type { WorkflowVmHostFailure } from "../../workflows/vm/host-types.js"
import type { Runner } from "../runner/types.js"
import type { ModuleRuntimes } from "../../infra/module-runtime.js"
import type { ControlInterruption, PlannedCutInterrupt, TurnInterruption } from "../session/conversation/turn-end-record.js"
import type { ChildCut } from "../session/child-continuation.js"
import type { BackgroundWorkTracking } from "../agent-runtime/background-work.js"
import type { WorkflowDeliveryAddress } from "../session/conversation/addressed-workflow-messages.js"

/** Explicit controls wake their address; only a successor supplies planned
 *  wake. A capacity continuation wakes only the agents of the conversations
 *  it names, whose capacity waits an earlier executor left (PI-MODEL-039);
 *  every other agent keeps the cut it ended with. */
export type WorkflowWake = WorkflowDeliveryAddress | "planned" | { readonly capacity: ReadonlySet<string> }

/** Whether the wake is an automatic continuation, which keeps every cut by a
 *  person or a parent agent, rather than a control that names its address. */
export function automaticWake(wake: WorkflowWake | undefined): wake is "planned" | { readonly capacity: ReadonlySet<string> } {
  return wake === "planned" || (typeof wake === "object" && "capacity" in wake)
}

// Optional-field shape is deliberate: the result is a *single* return value
// constructed once at the end of workflow-runner.run(); never incrementally
// spread-updated. Discriminating it would cascade `kind` through ~70 call
// sites across session-store, workflow-controller, run-headless, ~60 tests,
// and headless adapters, for a minor type-safety win where the only invariant
// ("completed ⇒ no reason") holds by construction in one function. Keeping
// this shape flat is the more elegant tradeoff for the current surface area.
export interface WorkflowResult {
  completed: boolean
  attemptsCompleted: number
  attemptsTotal: number
  cost: number
  tokens: number
  reason?: string
}

/** A terminal run can release its live owner only after parent result and notice admission are durable. */
export interface WorkflowCompletionAcknowledgement {
  readonly durable: boolean
}

export class WorkflowPreflightError extends Error {
  override readonly name = "WorkflowPreflightError"
  constructor(readonly failure: WorkflowVmHostFailure) {
    super(failure.message)
  }
}

/** What a person's Resume of the agent they interrupted did. */
export type WorkflowHandBack =
  | { readonly kind: "continued" }
  /** No agent of this run waits for the person. */
  | { readonly kind: "not_parked" }
  /** A module the run requires is off, so the agent stays interrupted.
   *  `reason` names each module and how to turn it on. */
  | { readonly kind: "refused"; readonly reason: string }

export interface WorkflowRunner extends Omit<Runner, "abort" | "interrupt" | "resume"> {
  /** Wakes only reached cuts and releases their pending coverage. Missing address means the whole workflow. */
  resume(address?: WorkflowDeliveryAddress): Promise<boolean>
  /** A capacity wake of the agents of `conversationIds` while the run lives:
   *  each one that the runtime or a replacement cut continues, and every
   *  other cut stays. The conversations that continue now, including an
   *  agent that runs. */
  continueCapacity(conversationIds: ReadonlySet<string>): ReadonlySet<string>
  /** Cuts reached attempts as `by` and retains addressed coverage for workers still assembling.
   * Refuses the whole addressed request when any target has not started.
   * Missing address means the whole workflow. Sibling cuts remain independent. */
  interrupt(by: ControlInterruption, address?: WorkflowDeliveryAddress): Promise<boolean>
  /** Person-first aggregate actor only when every committed started attempt is cut. */
  interruption(): ControlInterruption | undefined
  /** Person-first reached cut. Initialized live evidence, including uncut, supersedes
   * only its own attempt's durable turn end; unopened attempts retain durable authority. */
  cut(address?: WorkflowDeliveryAddress): Promise<ChildCut | undefined>
  /** A person's Resume of the agent they interrupted. It is new work, so it
   *  admits the modules this run was admitted for: the requirement closure of
   *  the definition revision the run captured, which a live Resume keeps
   *  (ARCH-WORKFLOWS-031). The person's messages that wait for the agent continue it;
   *  with none, the agent continues in its own conversation. */
  handBack(address?: WorkflowDeliveryAddress): Promise<WorkflowHandBack>
  /** Continues the agent a person interrupted with their messages that wait
   *  for it, once the modules the run requires are on. A message waits when
   *  the person sends it while such a module is off. Does nothing while a
   *  module stays off, while no message waits, or while no agent waits for
   *  the person. Never rejects. */
  continueHeldMessages(): Promise<void>
  run(): Promise<WorkflowResult>
  prepare(): Promise<WorkflowVmHostFailure | null>
  readQueue(): Promise<WorkflowView>
  /** Ends the run in this runner: a Stop ends it for good, and a runtime
   *  stop or a replacement leaves it to resume. `cause` names who ended it,
   *  and the run records it as the reason of its abort, so a runtime pause
   *  never reads as a person's Stop. */
  abort(cause: TurnInterruption): Promise<void>
  /** A planned replacement's cut: each running agent's worker is
   *  interrupted by the runtime. A running shell command is never cut: the caller moves
   *  held foreground commands to the background first, and the agent's owner
   *  hands every running command over when it closes. True when it
   *  interrupted a running turn. */
  interruptForReplacement(): Promise<boolean>
  /** An interrupt by `by` of the agent turn that a planned replacement's
   *  cut ended, which a successor still owes: the agent's worker, which holds
   *  the conversation, records the turn end that names `by` through its own
   *  writer and shows it as `interrupt` does. Resolves once the record is durable, or, while the cut turn still
   *  unwinds, once its one record will name the person; or at once with why
   *  it recorded nothing (`PlannedCutInterrupt`). */
  interruptPlannedCut(by: ControlInterruption, address?: WorkflowDeliveryAddress): Promise<PlannedCutInterrupt>
  /** Waits for a running or pending agent's host while the workflow runs; returns nothing for an inactive workflow or an agent it no longer runs. */
  stepModuleRuntimes(conversationId: string): Promise<ModuleRuntimes | undefined>
  /** The matching assembled agent's registry, absent after its host ends. */
  stepBackgroundTasks(conversationId: string): BackgroundWorkTracking | undefined
  releaseForegroundBash(toolUseId: string): boolean
  /** A planned replacement's move of every held foreground command of the
   *  agents and their children to the background before its
   *  cut interrupts them. Resolves once the registry tracks each moved
   *  command or it has ended; a command held later moves at once. */
  transferForegroundForReplacement(): Promise<void>
  terminateBackgroundWork(toolUseId: string): void
}
