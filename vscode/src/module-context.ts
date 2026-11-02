import { MODULE_IDS, type ModuleId } from "../../src/protocol/module-ids.js"

/** The `when` clause context of the project's modules: `flywheel.modulesKnown`
 *  once the client has named the enabled modules, and `flywheel.module.<id>`
 *  for every module. A palette command that a module owns names its module in
 *  `package.json`, as `!flywheel.modulesKnown || flywheel.module.<id>`, so it
 *  shows only while that module is on. Before the client names the modules,
 *  and with a client too old to name them, every command shows. */
export function moduleContext(enabled: readonly ModuleId[] | undefined): ReadonlyArray<readonly [string, boolean]> {
  return [
    ["flywheel.modulesKnown", enabled !== undefined],
    ...MODULE_IDS.map((id) => [`flywheel.module.${id}`, enabled?.includes(id) ?? false] as const),
  ]
}

/** Applies `moduleContext` through `setContext` only when the enabled modules
 *  change. The client publishes its summary on every paint, and most paints
 *  change no module. */
export function createModuleContextPublisher(setContext: (key: string, value: boolean) => void): (enabled: readonly ModuleId[] | undefined) => void {
  let published: string | undefined
  return (enabled) => {
    const identity = enabled === undefined ? "" : `:${[...enabled].sort().join(",")}`
    if (identity === published) return
    published = identity
    for (const [key, value] of moduleContext(enabled)) setContext(key, value)
  }
}
