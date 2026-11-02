import { composeRealmModuleSnapshot, type FirstPartyModuleComposition } from "../modules.js"

/** Compose the root and admitted child selections of one runtime. Tool exclusions
 * leave their modules enabled, but remove each tool and its associated roster. */
export function createRuntimeModuleComposer(disabledTools: readonly string[] = []): typeof composeRealmModuleSnapshot {
  const filtered = new WeakMap<FirstPartyModuleComposition, FirstPartyModuleComposition>()
  let validated = false
  return (state, modules) => {
    const composition = composeRealmModuleSnapshot(state, modules)
    if (disabledTools.length === 0) return composition
    if (!validated) {
      const activeToolNames = new Set(composition.contributions.flatMap((contribution) => contribution.domain === "tools" ? [contribution.value.name] : []))
      const unknown = disabledTools.filter((name) => !activeToolNames.has(name))
      if (unknown.length > 0) throw new Error(`Unknown active first-party tool: ${unknown.join(", ")}`)
      validated = true
    }
    let selection = filtered.get(composition)
    if (!selection) {
      selection = headlessModuleComposition(composition, disabledTools)
      filtered.set(composition, selection)
    }
    return selection
  }
}

/** Filter previously validated canonical names even after their modules turn off. */
function headlessModuleComposition(composition: FirstPartyModuleComposition, disabledTools: readonly string[]): FirstPartyModuleComposition {
  const toolContributions = composition.contributions.filter((contribution) => contribution.domain === "tools")
  const disabledToolNames = new Set(disabledTools)
  const disabledPromptRosterIds = new Set<string>(toolContributions
    .filter((contribution) => disabledToolNames.has(contribution.value.name))
    .flatMap((contribution) => contribution.value.associatedPromptRosterIds ?? []))
  return Object.freeze({
    ...composition,
    contributions: Object.freeze(composition.contributions.filter((contribution) =>
      (contribution.domain !== "tools" || !disabledToolNames.has(contribution.value.name))
      && (contribution.domain !== "promptRosters" || !disabledPromptRosterIds.has(contribution.id)))),
  })
}
