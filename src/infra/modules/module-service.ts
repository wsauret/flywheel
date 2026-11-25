/** Typed key for one module's process-scoped service instance: the sibling of
 *  the per-runner runtime handle in `module-runtime.ts`. A service is built
 *  once per process when the module first becomes enabled, and the phantom type lets the
 *  module, and any module that lists it as a dependency, read the instance
 *  back with its declared type. */
export interface ModuleServiceHandle<T> {
  readonly moduleId: string
  readonly __type?: T
}

export function moduleServiceHandle<T>(moduleId: string): ModuleServiceHandle<T> {
  return { moduleId }
}

export interface ModuleServices {
  /** The instance already activated for this process, including while off,
   *  or undefined before activation or when the module declares no service.
   *  Callers use the live selection to decide whether new work is admitted. */
  get<T>(handle: ModuleServiceHandle<T>): T | undefined
}

/** Binds constructed instances to their owning module ids. */
export function composeModuleServices(entries: Iterable<readonly [moduleId: string, instance: unknown]>): ModuleServices {
  const instances = new Map<string, unknown>(entries)
  return {
    get<T>(handle: ModuleServiceHandle<T>): T | undefined {
      // SAFETY: the map is heterogeneous by construction and the handle's phantom type is the declared contract: the one module that owns the id also owns the factory whose return this instance is.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the handle's phantom type is the declared instance contract
      return instances.get(handle.moduleId) as T | undefined
    },
  }
}

export const NO_MODULE_SERVICES: ModuleServices = composeModuleServices([])
