/** Typed key for the host that commits one kind of retained operation. The
 *  module that owns the kind decodes its cells and reads its host back with
 *  this handle; the composition that runs the work binds the host under the
 *  same kind. The phantom type is the declared host contract. */
interface RetainedOperationHostHandle<Host> {
  readonly kind: string
  readonly __host?: Host
}

export function retainedOperationHostHandle<Host>(kind: string): RetainedOperationHostHandle<Host> {
  return { kind }
}

export interface RetainedOperationHosts {
  /** The host the composition bound for the handle's kind, or undefined when
   *  this composition commits no operation of that kind. */
  get<Host>(handle: RetainedOperationHostHandle<Host>): Host | undefined
}

declare const boundHost: unique symbol

/** One host bound to the kind of its handle. Only `bindRetainedOperationHost`
 *  makes one, so the compiler checked the host against the handle's contract. */
interface RetainedOperationHostBinding {
  readonly kind: string
  readonly host: unknown
  readonly [boundHost]: true
}

/** Binds `host` to the kind `handle` names. `NoInfer` makes the handle alone
 *  set the contract, so a host that does not satisfy it does not compile. */
export function bindRetainedOperationHost<Host>(handle: RetainedOperationHostHandle<Host>, host: NoInfer<Host>): RetainedOperationHostBinding {
  // SAFETY: the brand is a compile-time marker with no runtime value; this function is the one place that makes a binding, after the host passed the handle's contract.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the brand marks bindings this function checked
  return { kind: handle.kind, host } as RetainedOperationHostBinding
}

/** The hosts a composition owns, each bound to the retained-operation kind it commits. */
export function composeRetainedOperationHosts(bindings: Iterable<RetainedOperationHostBinding>): RetainedOperationHosts {
  const hosts = new Map<string, unknown>(Array.from(bindings, ({ kind, host }) => [kind, host]))
  return {
    get<Host>(handle: RetainedOperationHostHandle<Host>): Host | undefined {
      // SAFETY: the map is heterogeneous by construction, and each host in it passed the contract of a handle of its kind at `bindRetainedOperationHost`; the one contract that declares the kind declares that handle.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the handle's phantom type is the declared host contract
      return hosts.get(handle.kind) as Host | undefined
    },
  }
}
