/** Typed key for one module's process-scoped service instance: the sibling of
 *  the per-runner runtime handle in `module-runtime.ts`. A service is built
 *  once per process when the module first becomes enabled, and the phantom type lets the
 *  module, and any module that lists it as a dependency, read the instance
 *  back with its declared type. A module whose service runs in execution may
 *  also declare a control part, whose instance has its own handle. */
export interface ModuleServiceHandle<T> {
  readonly moduleId: string
  readonly part?: "control"
  readonly __type?: T
}

export function moduleServiceHandle<T>(moduleId: string, part?: "control"): ModuleServiceHandle<T> {
  return part === undefined ? { moduleId } : { moduleId, part }
}

/** The key under which composition binds the instance of one module part. */
export function moduleServiceKey(moduleId: string, part?: "control"): string {
  return part === undefined ? moduleId : `${moduleId}:${part}`
}

export interface ModuleServices {
  /** The instance already activated for this process, including while off,
   *  or undefined before activation or when the module declares no service.
   *  Callers use the live selection to decide whether new work is admitted. */
  get<T>(handle: ModuleServiceHandle<T>): T | undefined
}

/** Binds constructed instances to the keys of their module parts (`moduleServiceKey`). */
export function composeModuleServices(entries: Iterable<readonly [key: string, instance: unknown]>): ModuleServices {
  const instances = new Map<string, unknown>(entries)
  return {
    get<T>(handle: ModuleServiceHandle<T>): T | undefined {
      // SAFETY: the map is heterogeneous by construction and the handle's phantom type is the declared contract: the one module part that owns the key also owns the factory whose return this instance is.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the handle's phantom type is the declared instance contract
      return instances.get(moduleServiceKey(handle.moduleId, handle.part)) as T | undefined
    },
  }
}

export const NO_MODULE_SERVICES: ModuleServices = composeModuleServices([])
