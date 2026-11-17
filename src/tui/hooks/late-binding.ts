interface LateBinding<A extends readonly unknown[], R> {
  readonly call: (...args: A) => R
  bind(target: (...args: A) => R): void
}

/** One call that closes a cycle between the shell's owners, where an owner
 *  built earlier calls one built later: a modal opens a session, and the
 *  session's viewer opens the modal again. The later owner binds the call
 *  while the shell sets up, and a person can reach it only after the shell
 *  mounts, so a call before the bind is a wiring defect. */
export function createLateBinding<A extends readonly unknown[], R>(name: string): LateBinding<A, R> {
  let target: ((...args: A) => R) | undefined
  return {
    call: (...args) => {
      if (target === undefined) throw new Error(`The shell called ${name} before its owner bound it`)
      return target(...args)
    },
    bind(next) { target = next },
  }
}
