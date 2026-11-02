import { createHash } from "node:crypto"
import { errorMessage } from "../infra/error-message.js"
import { Log } from "../infra/log.js"

const log = Log.create({ service: "module-hooks" })

export interface ModuleObserverHook<Event> {
  readonly id: string
  readonly observe: (event: Event) => void
}

/** Fans one lifecycle event to every observer. Observer failures and return
 *  values never affect delivery or control flow. The notify seam is the one
 *  async observer: its host in `app-service/module-service-host.ts` awaits
 *  each observer's settlement instead of this runner, so a producer can order
 *  work after the commit. */
export function runModuleObserverHooks<Event>(hooks: readonly ModuleObserverHook<Event>[], event: Event): void {
  for (const hook of hooks) {
    try {
      hook.observe(event)
    } catch (error) {
      log.error("capability observer failed", { observerId: hook.id, error: errorMessage(error) })
    }
  }
}

type ModuleGateDecision<ExecutionContext, Output> =
  | { readonly kind: "allow" }
  | { readonly kind: "veto"; readonly reason: string }
  | { readonly kind: "replace"; readonly execute: (context: ExecutionContext) => Promise<Output> }

export type ModuleGate<Input, ExecutionContext, Output> = (input: Input) => ModuleGateDecision<ExecutionContext, Output> | Promise<ModuleGateDecision<ExecutionContext, Output>>

export class ModuleGateRefusal extends Error {
  override readonly name = "ModuleGateRefusal"
}

/** Runs one singleton gate. An absent gate takes the exact core path; gate failures refuse instead of falling through. */
export async function runModuleGate<Input, ExecutionContext, Output>(
  gate: ModuleGate<Input, ExecutionContext, Output> | undefined,
  input: Input,
  executionContext: ExecutionContext,
  executeCore: () => Promise<Output>,
): Promise<Output | { readonly kind: "veto"; readonly reason: string }> {
  if (!gate) return executeCore()
  let decision: ModuleGateDecision<ExecutionContext, Output>
  try {
    decision = await gate(input)
  } catch (error) {
    throw new ModuleGateRefusal(`Capability gate failed closed: ${errorMessage(error)}`)
  }
  if (decision.kind === "allow") return executeCore()
  return decision.kind === "veto" ? decision : decision.execute(executionContext)
}

interface ModuleTransformer<Value> {
  readonly seam: PropertyKey
  readonly id: string
  readonly order: number
  readonly transformer: (value: Value) => Value
}

export interface ModuleTransformerApplication {
  readonly applicationId: string
  readonly transformerId: string
  readonly seam: string
  readonly order: number
  readonly outcome: "applied" | "error"
  readonly inputHash: string
  readonly outputHash: string
}

interface ModuleTransformerChainInput<Value> {
  readonly seam: PropertyKey
  readonly value: Value
  readonly applicationIdentity: string
  readonly transformers: readonly ModuleTransformer<Value>[]
}

interface ModuleTransformerChainResult<Value> {
  readonly value: Value
  readonly applications: readonly ModuleTransformerApplication[]
}

function hash(value: unknown): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value) ?? "undefined"
  return createHash("sha256").update(serialized).digest("hex")
}

/** Applies one transformer seam deterministically. Failures retain the last successful value and are recorded without model-visible bytes. */
export function runModuleTransformerChain<Value>(input: ModuleTransformerChainInput<Value>): ModuleTransformerChainResult<Value> {
  const seam = String(input.seam)
  const transformers = input.transformers
    .filter((declaration) => declaration.seam === input.seam)
    .toSorted((left, right) => left.order - right.order || left.id.localeCompare(right.id))
  const applications: ModuleTransformerApplication[] = []
  let value = input.value

  for (const declaration of transformers) {
    const inputHash = hash(value)
    let outcome: ModuleTransformerApplication["outcome"] = "applied"
    try {
      value = declaration.transformer(value)
    } catch (error) {
      outcome = "error"
      log.error("capability transformer failed", { transformerId: declaration.id, seam, order: declaration.order, error: errorMessage(error) })
    }
    const outputHash = hash(value)
    applications.push({
      applicationId: hash(`${input.applicationIdentity}\u0000${seam}\u0000${declaration.order}\u0000${declaration.id}`),
      transformerId: declaration.id,
      seam,
      order: declaration.order,
      outcome,
      inputHash,
      outputHash,
    })
  }

  return { value, applications }
}
