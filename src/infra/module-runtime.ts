/** Typed key for one module's per-runner runtime instance. The phantom type
 *  lets a module read its own instance back with its declared type. */
export interface ModuleRuntimeHandle<T> {
  readonly moduleId: string
  readonly __type?: T
}

export function moduleRuntimeHandle<T>(moduleId: string): ModuleRuntimeHandle<T> {
  return { moduleId }
}

export interface ModuleRuntimes {
  /** The instance an enabled module constructed for this runner, or undefined
   *  when the module is disabled or declares no runtime. */
  get<T>(handle: ModuleRuntimeHandle<T>): T | undefined
}

/** Binds constructed instances to their owning module ids. An entry whose
 *  instance is undefined reads back as absent, so a factory that declines to
 *  build for this runner needs no separate registration step. */
export function composeModuleRuntimes(entries: Iterable<readonly [moduleId: string, instance: unknown]>): ModuleRuntimes {
  const instances = new Map<string, unknown>(entries)
  return {
    get<T>(handle: ModuleRuntimeHandle<T>): T | undefined {
      // SAFETY: the map is heterogeneous by construction and the handle's phantom type is the declared contract: the one module that owns the id also owns the factory whose return this instance is.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the handle's phantom type is the declared instance contract
      return instances.get(handle.moduleId) as T | undefined
    },
  }
}

export const NO_MODULE_RUNTIMES: ModuleRuntimes = composeModuleRuntimes([])
