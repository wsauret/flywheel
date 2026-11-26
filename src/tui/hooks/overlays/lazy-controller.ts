import { createRoot, getOwner, onCleanup } from "solid-js"

/** A controller whose code loads on first use. */
export interface LazyController<C> {
  /** The created controller, or undefined until the first load settles. */
  readonly current: () => C | undefined
  /** Resolves the controller, loading its code and creating it on the first
   *  call. Concurrent calls share one load, and a failed load rejects and
   *  lets the next call try again. Resolves undefined when `clear` or the
   *  owner's disposal overtook the load. */
  readonly load: () => Promise<C | undefined>
  /** Disposes the created controller; the next load creates a fresh one. */
  readonly clear: () => void
}

/** The terminal's one lazy controller loader, for the kernel modals and the
 *  module surfaces alike. `load` imports the controller's code, and `create`
 *  builds the controller from it once, in its own root under the owner that
 *  called this function, so the controller reads that owner's contexts and is
 *  disposed with it. The controller is ready one microtask after its code,
 *  which keeps an opening that waits for it in step with the load. */
export function createLazyController<M, C>(load: () => Promise<M>, create: (loaded: M) => C): LazyController<C> {
  const owner = getOwner()
  let alive = true
  let generation = 0
  let created: { readonly controller: C; readonly dispose: () => void } | undefined
  let pending: Promise<C | undefined> | undefined
  const clear = (): void => {
    generation += 1
    created?.dispose()
    created = undefined
    pending = undefined
  }
  onCleanup(() => { alive = false; clear() })
  return {
    current: () => created?.controller,
    load: () => {
      if (created) return Promise.resolve(created.controller)
      if (pending) return pending
      const request = generation
      const settle = (): boolean => {
        if (request !== generation) return false
        pending = undefined
        return alive
      }
      pending = load().then((loaded) => settle() ? createRoot((dispose) => {
        const controller = create(loaded)
        created = { controller, dispose }
        return controller
      }, owner) : undefined, (error: unknown) => {
        settle()
        throw error
      })
      return pending
    },
    clear,
  }
}
