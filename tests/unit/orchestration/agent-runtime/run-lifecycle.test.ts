import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import { RunLifecycle } from "../../../../src/orchestration/agent-runtime/run-lifecycle"

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 30) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Effect resumes fibers through setImmediate. After these turns, a settlement
 *  that nothing holds back has already reached every `then` of `done`. */
async function drainScheduler(): Promise<void> {
  for (let turn = 0; turn < 16; turn++) await new Promise<void>((resolve) => { setImmediate(resolve) })
}

describe("RunLifecycle", () => {
  test("idle start transitions to running and busy start is deterministic", async () => {
    const lifecycle = new RunLifecycle<string>()
    let resolveRun!: (value: string) => void

    expect(lifecycle.start(() => new Promise<string>((resolve) => { resolveRun = resolve }))).toBe(true)
    expect(lifecycle.start(async () => "second")).toBe(false)
    await Bun.sleep(0)

    resolveRun("first")
    await expect(withTimeout(lifecycle.done, "run did not finish")).resolves.toBe("first")
  })

  test("carries an interrupt that arrives before the first turn opens", async () => {
    const lifecycle = new RunLifecycle<"interrupted">()
    const runStarted = Promise.withResolvers<void>()
    const openTurn = Promise.withResolvers<void>()
    let turnWasInterrupted = false

    lifecycle.start(async () => {
      runStarted.resolve()
      await openTurn.promise
      const turn = lifecycle.beginTurn()
      turnWasInterrupted = turn.signal.aborted
      await turn.end()
      return "interrupted"
    })

    await runStarted.promise
    expect(lifecycle.interrupt()).toBe(true)
    openTurn.resolve()
    await lifecycle.done

    expect(turnWasInterrupted).toBe(true)
  })

  test("an interrupt that finds its turn already interrupted carries into the next turn, unless a hand-back discards it", async () => {
    for (const handBack of [false, true]) {
      const lifecycle = new RunLifecycle<"done">()
      const firstOpen = Promise.withResolvers<void>()
      const interruptedTwice = Promise.withResolvers<void>()
      let nextTurnAbortedAtOpen: boolean | undefined

      lifecycle.start(async () => {
        const first = lifecycle.beginTurn()
        firstOpen.resolve()
        await interruptedTwice.promise
        // The person's Resume or message: it discards an Escape that came before it.
        if (handBack) lifecycle.discardPendingInterrupt()
        await first.end()
        const next = lifecycle.beginTurn()
        nextTurnAbortedAtOpen = next.signal.aborted
        await next.end()
        return "done"
      })

      await firstOpen.promise
      expect(lifecycle.interrupt()).toBe(true)
      // The turn's signal is already aborted, and the run is alive and has not
      // opened its next turn: the Escape waits for it.
      const secondInterrupt = lifecycle.interrupt()
      interruptedTwice.resolve()
      await lifecycle.done

      expect(secondInterrupt).toBe(true)
      expect(nextTurnAbortedAtOpen).toBe(!handBack)
    }
  })

  test("ESC interrupts the turn's child fiber only; the run stays alive", async () => {
    const lifecycle = new RunLifecycle<string>()
    const turnStarted = Promise.withResolvers<void>()
    let childInterrupted = false
    let runSignalAborted = false
    let settlement = "never settled"

    lifecycle.start(async (runSignal) => {
      const turn = lifecycle.beginTurn()
      turnStarted.resolve()
      settlement = await turn
        .settle(() => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { childInterrupted = true }))))
        .then(() => "settled", () => "interrupted")
      runSignalAborted = runSignal.aborted
      await turn.end()
      return "run outlived its turn"
    })

    await withTimeout(turnStarted.promise, "turn did not start")
    await Bun.sleep(1)
    expect(lifecycle.interrupt()).toBe(true)

    await expect(withTimeout(lifecycle.done, "run died with its turn")).resolves.toBe("run outlived its turn")
    expect(childInterrupted).toBe(true)
    expect(settlement).toBe("interrupted")
    expect(runSignalAborted).toBe(false)
  })

  test("run abort interrupts the turn child, and done waits for the run body to settle", async () => {
    const lifecycle = new RunLifecycle<string>()
    const turnStarted = Promise.withResolvers<void>()
    const finishRun = Promise.withResolvers<void>()
    let childInterrupted = false

    lifecycle.start(async (runSignal) => {
      const turn = lifecycle.beginTurn()
      turnStarted.resolve()
      await turn
        .settle(() => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { childInterrupted = true }))))
        .catch(() => undefined)
      // Stands in for a loop still unwinding its durable writes after the abort.
      await finishRun.promise
      return runSignal.aborted ? "settled after abort" : "never aborted"
    })

    await withTimeout(turnStarted.promise, "turn did not start")
    await Bun.sleep(1)
    lifecycle.abort("abort-result")
    await Bun.sleep(20)

    let settled = false
    void lifecycle.done.then(() => { settled = true })
    await Bun.sleep(5)
    expect(childInterrupted).toBe(true)
    expect(settled).toBe(false)

    finishRun.resolve()
    await expect(withTimeout(lifecycle.done, "late run settlement did not resolve done")).resolves.toBe("settled after abort")
  })

  test("an interrupt that arrives while an abort ends the current turn answers at once: the aborted run takes no interrupt", async () => {
    const lifecycle = new RunLifecycle<string>()
    const turnStarted = Promise.withResolvers<void>()
    const aborting = Promise.withResolvers<void>()
    const toolStopped = Promise.withResolvers<void>()
    const releaseTool = Promise.withResolvers<void>()

    lifecycle.start(async (runSignal) => {
      const turn = lifecycle.beginTurn()
      // A foreground tool that takes time to stop once its turn ends, as a
      // provider stream or a shell command does, so the abort's end of the
      // turn is still waiting for it.
      Effect.runSync(Effect.forkIn(Effect.uninterruptible(Effect.promise(async () => {
        await releaseTool.promise
        toolStopped.resolve()
      })), turn.scope))
      turnStarted.resolve()
      await new Promise<void>((resolve) => runSignal.addEventListener("abort", () => resolve(), { once: true }))
      aborting.resolve()
      return "aborted"
    })

    await withTimeout(turnStarted.promise, "turn did not start")
    lifecycle.abort("abort-result")
    // The run signal fires inside the abort's transition, so the abort has
    // begun and the tool still holds the turn open.
    await withTimeout(aborting.promise, "abort did not reach the run")

    expect(lifecycle.interrupt()).toBe(false)
    expect(() => lifecycle.discardPendingInterrupt()).not.toThrow()
    releaseTool.resolve()
    await toolStopped.promise
    await expect(withTimeout(lifecycle.done, "aborted run did not settle")).resolves.toBe("aborted")
  })

  test("done stays pending until the turn the abort ends has closed every fiber it owns", async () => {
    const lifecycle = new RunLifecycle<string>()
    const turnStarted = Promise.withResolvers<void>()
    const runReturned = Promise.withResolvers<void>()
    const releaseTool = Promise.withResolvers<void>()
    const order: string[] = []

    lifecycle.start(async (runSignal) => {
      const turn = lifecycle.beginTurn()
      // A foreground tool that is still writing when its turn is told to end:
      // the caller of `done` disposes the writers such a tool writes through.
      Effect.runSync(Effect.forkIn(Effect.uninterruptible(Effect.promise(async () => {
        await releaseTool.promise
        order.push("tool stopped")
      })), turn.scope))
      turnStarted.resolve()
      // The run body returns as soon as its signal fires, before the turn ends.
      await new Promise<void>((resolve) => runSignal.addEventListener("abort", () => resolve(), { once: true }))
      runReturned.resolve()
      return "aborted"
    })

    await withTimeout(turnStarted.promise, "turn did not start")
    lifecycle.abort("abort-result")
    void lifecycle.done.then(() => { order.push("done") })
    await withTimeout(runReturned.promise, "abort did not reach the run")
    await drainScheduler()
    expect(order).toEqual([])

    releaseTool.resolve()
    await expect(withTimeout(lifecycle.done, "aborted run did not settle")).resolves.toBe("aborted")
    expect(order).toEqual(["tool stopped", "done"])
  })

  test("an interrupt landing in the turn's masked terminal phase still delivers its settlement", async () => {
    const lifecycle = new RunLifecycle<string>()
    const turnStarted = Promise.withResolvers<void>()
    let settlement = "never settled"

    lifecycle.start(async () => {
      const turn = lifecycle.beginTurn()
      // The shape of settleTurn: an interruptible provider region, then a
      // terminal phase that must reach its end, publish what it settled, and
      // have that publication survive the interrupt the mask deferred.
      settlement = await turn.settle<string>((publish) => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        turnStarted.resolve()
        const exit = yield* Effect.exit(restore(Effect.never))
        const settled = Exit.isFailure(exit) ? "terminal phase completed" : "provider was never interrupted"
        publish(settled)
        return settled
      })))
      await turn.end()
      return settlement
    })

    await withTimeout(turnStarted.promise, "turn work did not start")
    expect(lifecycle.interrupt()).toBe(true)

    await expect(withTimeout(lifecycle.done, "masked settlement was discarded")).resolves.toBe("terminal phase completed")
    expect(settlement).toBe("terminal phase completed")
  })

  test("no foreground fiber outlives the turn scope that owns it", async () => {
    const lifecycle = new RunLifecycle<string>()
    const turn = lifecycle.beginTurn()
    const started = Promise.withResolvers<void>()
    let interrupted = false

    const foreground = Effect.runSync(Effect.forkIn(
      Effect.sync(() => { started.resolve() }).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Effect.sync(() => { interrupted = true })),
      ),
      turn.scope,
    ))
    await withTimeout(started.promise, "foreground fiber did not start")

    await withTimeout(turn.end(), "turn end did not resolve")

    expect(interrupted).toBe(true)
    expect(turn.signal.aborted).toBe(true)
    expect(Exit.isFailure(await Effect.runPromise(Fiber.await(foreground)))).toBe(true)
  })

  test("abort fires the run signal and done resolves with the run's own settlement", async () => {
    const lifecycle = new RunLifecycle<string>()
    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => { resolveStarted = resolve })

    lifecycle.start((signal) => new Promise<string>((resolve) => {
      resolveStarted()
      signal.addEventListener("abort", () => resolve("run-settled"), { once: true })
    }))

    await withTimeout(started, "run did not start")
    lifecycle.abort("abort-result")
    // The run's terminal wins: done reflects what the loop actually did on
    // its way out, not the synthetic abort result.
    await expect(withTimeout(lifecycle.done, "abort did not settle done")).resolves.toBe("run-settled")
  })

  test("a rejected run settles done with the rejection instead of hanging", async () => {
    const lifecycle = new RunLifecycle<string>()
    lifecycle.start(async () => { throw new Error("loop defect") })

    await expect(withTimeout(lifecycle.done, "rejection did not settle done")).rejects.toThrow("loop defect")
  })

  test("a naturally settled run never fires its run signal", async () => {
    const lifecycle = new RunLifecycle<string>()
    let runAborted = false

    lifecycle.start(async (signal) => {
      signal.addEventListener("abort", () => { runAborted = true }, { once: true })
      return "settled"
    })

    await expect(withTimeout(lifecycle.done, "run did not settle")).resolves.toBe("settled")
    // Background work and tools hold this signal; a run that finished its work
    // must not look aborted to them.
    expect(runAborted).toBe(false)
  })

  test("repeated abort is idempotent; idle abort resolves done with the abort result", async () => {
    const idle = new RunLifecycle<string>()
    idle.abort("aborted")
    idle.abort("second")
    await expect(withTimeout(idle.done, "idle abort did not resolve done")).resolves.toBe("aborted")
    expect(idle.start(async () => "late")).toBe(false)

    const running = new RunLifecycle<string>()
    running.start((signal) => new Promise<string>((resolve) => {
      if (signal.aborted) {
        resolve("running-aborted")
        return
      }
      signal.addEventListener("abort", () => resolve("running-aborted"), { once: true })
    }))
    running.abort("first-abort")
    running.abort("second-abort")
    await expect(withTimeout(running.done, "running abort did not settle done")).resolves.toBe("running-aborted")
  })
})
