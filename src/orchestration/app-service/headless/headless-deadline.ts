/** The one reason a headless run stops at its deadline. Setup rejects with it,
 *  and every caller reports its message, so stderr and the summary name the
 *  deadline the same way wherever it lands. */
export class HeadlessDeadlineExpired extends Error {
  override readonly name = "HeadlessDeadlineExpired"
  constructor(readonly seconds: number) {
    super(`Headless deadline expired after ${seconds}s`)
  }
}

export interface HeadlessDeadlineController {
  readonly expired: boolean
  /** The deadline's reason once it fired. */
  readonly expiry: HeadlessDeadlineExpired | undefined
  awaitSetup<A>(operation: Promise<A>): Promise<A>
  awaitActive<A>(operation: Promise<A>, interrupt: () => void | Promise<void>): Promise<A>
  dispose(): void
}

/** Owns the single monotonic deadline for a complete headless attempt. Setup
 * operations lose the race without being joined because external preparation
 * can ignore cancellation. Active execution is interrupted and then joined. */
export function createHeadlessDeadline(deadlineSeconds?: number): HeadlessDeadlineController {
  const deadlineAt = deadlineSeconds === undefined ? undefined : performance.now() + deadlineSeconds * 1_000
  let expiry: HeadlessDeadlineExpired | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = deadlineAt === undefined || deadlineSeconds === undefined
    ? undefined
    : new Promise<HeadlessDeadlineExpired>((resolve) => {
        timer = setTimeout(() => {
          expiry = new HeadlessDeadlineExpired(deadlineSeconds)
          resolve(expiry)
        }, Math.max(0, deadlineAt - performance.now()))
      })

  const awaitSetup = async <A>(operation: Promise<A>): Promise<A> => {
    if (!deadline) return await operation
    // An expired deadline has already settled, so listing it first makes it
    // win over an operation that has also settled.
    const result = await Promise.race([deadline, operation])
    if (result instanceof HeadlessDeadlineExpired) throw result
    return result
  }

  const awaitActive = async <A>(operation: Promise<A>, interrupt: () => void | Promise<void>): Promise<A> => {
    if (!deadline) return await operation
    const result = await Promise.race([operation, deadline])
    if (!(result instanceof HeadlessDeadlineExpired)) return result
    await interrupt()
    return await operation
  }

  return {
    get expired() {
      return expiry !== undefined
    },
    get expiry() {
      return expiry
    },
    awaitSetup,
    awaitActive,
    dispose() {
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}
