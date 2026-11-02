import type { ModuleRow } from "../protocol-module.js"
import { explainedByConnection } from "./connection-failures.js"

/** A status reading belongs to exactly one selection, session, and auth profile. */
export interface ModuleStatusScope {
  readonly sessionId: string | undefined
  readonly profileId: string | undefined
  readonly moduleIds: readonly string[]
}

export function sameModuleStatusScope(left: ModuleStatusScope, right: ModuleStatusScope): boolean {
  return left.sessionId === right.sessionId && left.profileId === right.profileId && left.moduleIds.length === right.moduleIds.length && left.moduleIds.every((id, index) => id === right.moduleIds[index])
}

/** Reads independent module status contributions in parallel, preserves registry
 *  order, and reports each failed contribution once through the client's sink.
 *
 *  A failure that the runtime's own state explains is not the module's to
 *  report: a read the connection explains (`explainedByConnection`), which
 *  its lane took down or which timed out while the runtime was silent, and
 *  any read that fails while the runtime does not answer this client
 *  (`answering`), whose fault notice already says why. A report beside that
 *  notice would contradict it with a second cause, so such a module's rows
 *  stay absent until a reading succeeds. */
export async function readModuleStatusRows<Module extends { readonly id: string }>(
  modules: readonly Module[],
  scope: ModuleStatusScope,
  read: (module: Module, sessionId: string | undefined) => Promise<readonly ModuleRow[]> | undefined,
  report: (module: Module, error: unknown) => void,
  answering: () => boolean,
): Promise<readonly ModuleRow[]> {
  return (await Promise.all(modules.filter((module) => scope.moduleIds.includes(module.id)).map(async (module) => {
    try { return await read(module, scope.sessionId) ?? [] }
    catch (error) {
      if (answering() && !explainedByConnection(error)) report(module, error)
      return []
    }
  }))).flat()
}
