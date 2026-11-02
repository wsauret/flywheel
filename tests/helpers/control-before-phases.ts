import type { CommittedWorkflowControl } from "../../src/workflows/vm/committed-control.js"
import type { FollowUpV10 } from "../../src/workflows/vm/graph-types.js"

/** A control of agents as a root from before phases records it: `step`
 *  nodes with `then`, retry as `maxIterations` and `detectStuck`, `forItem`
 *  on each attempt, and the guardrail keys of that time. Tests feed it to the
 *  readers of version 10 and earlier roots, which must keep reading it.
 *  Throws for any other node kind, which this shape does not cover. */
export function controlBeforePhases(control: CommittedWorkflowControl) {
  const { maxAttempts, maxInserts, insertsUsed, ...guardrails } = control.guardrails
  return {
    ...control,
    graph: {
      ...control.graph,
      // Control before phases always stored the budgets of its phases.
      budgets: control.graph.budgets ?? [],
      nodes: control.graph.nodes.map((node) => {
        if (node.kind !== "agent") throw new Error(`controlBeforePhases covers agent nodes only, not "${node.kind}"`)
        const { condition: _condition, retry, followUpV10, ...rest } = node
        return {
          ...rest,
          kind: "step",
          then: followUpV10 ?? null,
          retry: retry === null ? null : { maxIterations: retry.max, detectStuck: retry.stuck },
        }
      }),
    },
    attempts: control.attempts.map(({ item, provenance, ...attempt }) => ({
      ...attempt,
      provenance: provenance._tag === "followUpV10" ? { _tag: "then" } : provenance,
      forItem: item,
    })),
    guardrails: { ...guardrails, maxQueueLength: maxAttempts, maxSessionInserts: maxInserts, sessionInsertsUsed: insertsUsed },
  }
}

/** The compiled control of a workflow of one-agent phases as a build before
 *  phases compiled a `then` chain of the same records: the first phase's
 *  node runs each later phase's record as a follow-up attempt of its own,
 *  which the history arm `followUpV10` of its node states. Tests of that
 *  arm start from it, because no phase-grammar launch compiles one. */
export function asThenChain(control: CommittedWorkflowControl): CommittedWorkflowControl {
  const [first, ...rest] = control.graph.nodes
  if (first?.kind !== "agent" || rest.some(({ kind, ownership }) => kind !== "agent" || ownership._tag !== "workflow")) {
    throw new Error("asThenChain covers a workflow of one-agent phases only")
  }
  const followUpV10 = rest.reduceRight<FollowUpV10 | null>((then, node) => node.kind === "agent" ? { step: node.definitionId, when: null, then } : then, null)
  const kept = (id: string) => id === first.id || id.startsWith(`${first.id}:`)
  return {
    ...control,
    graph: { ...control.graph, nodes: [followUpV10 === null ? first : { ...first, followUpV10 }], dependencies: [] },
    attempts: control.attempts.filter(({ logicalNodeId }) => kept(logicalNodeId)),
    guardrails: { ...control.guardrails, attemptMutationsUsed: control.guardrails.attemptMutationsUsed.filter(({ attemptId }) => kept(attemptId)) },
  }
}
