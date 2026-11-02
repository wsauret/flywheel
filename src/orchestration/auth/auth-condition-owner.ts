import { authStoreObservationKey, reportAuthStoreObservation, type AuthStoreCondition, type AuthStoreLoadResult } from "../../infra/auth/auth-store.js"
import { Log } from "../../infra/log.js"

const log = Log.create({ service: "auth-conditions" })

export interface AuthConditionOwner {
  observeLoad(authDirectory: string, load: AuthStoreLoadResult): boolean
  observeNormalizationRefusal(authDirectory: string): void
  observeMutation(conditions: readonly AuthStoreCondition[]): void
  snapshot(authDirectory: string): readonly AuthStoreCondition[]
  remove(authDirectory: string): void
}

/** Owns current, secret-free auth storage conditions for one runtime process. */
export function createAuthConditionOwner(onMutationObserved?: () => void): AuthConditionOwner {
  const byDirectory = new Map<string, AuthStoreCondition[]>()
  const admittedRevisions = new Map<string, { readonly revision: string; readonly observation: string; readonly normalizationRefused?: boolean }>()

  return {
    observeNormalizationRefusal(authDirectory) {
      const current = admittedRevisions.get(authDirectory)
      if (current === undefined || current.normalizationRefused) return
      admittedRevisions.set(authDirectory, { ...current, normalizationRefused: true })
      log.warn("auth normalization refused; current credentials remain read-only", { authDirectory, revision: current.revision })
    },
    observeLoad(authDirectory, load) {
      const observation = authStoreObservationKey(load)
      if (admittedRevisions.get(authDirectory)?.observation === observation) return false
      reportAuthStoreObservation(load)
      byDirectory.set(authDirectory, deduplicate(load.conditions))
      admittedRevisions.set(authDirectory, { revision: load.revision, observation })
      return true
    },
    observeMutation(conditions) {
      let changed = false
      for (const condition of conditions) {
        if (condition.kind === "malformed" && admittedRevisions.get(condition.authDirectory)?.revision !== condition.revision) continue
        const current = byDirectory.get(condition.authDirectory) ?? []
        const next = deduplicate([...current, condition])
        if (next.length === current.length) continue
        byDirectory.set(condition.authDirectory, next)
        changed = true
      }
      if (changed) onMutationObserved?.()
    },
    snapshot(authDirectory) {
      return byDirectory.get(authDirectory) ?? []
    },
    remove(authDirectory) {
      byDirectory.delete(authDirectory)
      admittedRevisions.delete(authDirectory)
    },
  }
}

function deduplicate(conditions: readonly AuthStoreCondition[]): AuthStoreCondition[] {
  const unique = new Map<string, AuthStoreCondition>()
  for (const condition of conditions) unique.set(conditionKey(condition), condition)
  return [...unique.values()]
}

function conditionKey(condition: AuthStoreCondition): string {
  if (condition.kind === "refused") return `${condition.authDirectory}\0${condition.kind}\0${condition.category}\0${condition.scope}`
  const target = condition.scope === "provider" ? condition.providerId : condition.path
  return `${condition.authDirectory}\0${condition.revision}\0${condition.scope}\0${target}`
}
