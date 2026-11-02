import type { ManagedPackageMutation, ManagedPackageReach, ManagedPackageWrites } from "../../module-seams.js"
import type { SkillManageToolDeps } from "./tools/skill-manage.js"
import { planSkillMutation } from "./skill-mutation-plan.js"
import { publishSkillMutation } from "./skill-mutation-publisher.js"
import { refuseUncontainedSkillStores } from "./skill-store.js"

const NO_GLOBAL_AUTHORITY = "This session has no durable global skill publication authority."

/** The runner's managed publication authority. Consumers receive operations,
 *  while the module retains the origin, registry, and durable consent reader. */
export function createManagedPackageWrites(deps: SkillManageToolDeps): ManagedPackageWrites {
  const consent = deps.store && deps.sessionId ? { store: deps.store, sessionId: deps.sessionId } : undefined
  // The check and the publication plan through this one function, so they
  // refuse for the same reasons.
  const plan = (projectRoot: string, mutation: ManagedPackageMutation, reach: ManagedPackageReach) => {
    const config = { projectRoot, userDataRoot: deps.userDataRoot, registry: deps.registry }
    const uncontained = refuseUncontainedSkillStores(config)
    if (uncontained) return refused(uncontained)
    const planned = planSkillMutation(config, deps.origin, mutation)
    if (planned.kind === "refused") return planned
    if (planned.plan.reach !== reach) return refused(`The prepared package no longer resolves to the ${reach} skill store.`)
    return { kind: "planned" as const, config, plan: planned.plan }
  }
  return {
    review: deps.origin.kind === "review",
    ...(consent ? { consent } : {}),
    check({ projectRoot, mutation, reach }) {
      if (reach === "global" && !consent) return NO_GLOBAL_AUTHORITY
      const planned = plan(projectRoot, mutation, reach)
      return planned.kind === "refused" ? planned.error : undefined
    },
    async applyGlobal({ projectRoot, mutation, toolUseId, writer }) {
      if (!consent) return refused(NO_GLOBAL_AUTHORITY)
      const planned = plan(projectRoot, mutation, "global")
      if (planned.kind === "refused") return planned
      const publication = await publishSkillMutation({ config: planned.config, origin: deps.origin, plan: planned.plan, writer, global: { sessionId: consent.sessionId, toolUseId, store: consent.store, writer } })
      if (publication.kind === "refused" || publication.kind === "stale") return refused(publication.error)
      return { kind: "written", auditPending: publication.kind === "published_unsettled" }
    },
    async applyProject({ projectRoot, mutation, writer }) {
      const planned = plan(projectRoot, mutation, "project")
      if (planned.kind === "refused") return planned
      const publication = await publishSkillMutation({ config: planned.config, origin: deps.origin, plan: planned.plan, writer })
      if (publication.kind === "refused" || publication.kind === "stale") return refused(publication.error)
      return { kind: "written", auditPending: publication.kind === "published_unsettled" }
    },
  }
}

function refused(error: string) {
  return { kind: "refused" as const, error }
}
