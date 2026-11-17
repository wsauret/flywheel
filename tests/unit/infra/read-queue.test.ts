import { describe, expect, mock, test } from "bun:test"
import { createReadQueue } from "../../../src/infra/read-queue.js"

describe("createReadQueue", () => {
  test("callers that arrive while a read runs share one later read, and a caller never joins a read that already started", async () => {
    const firstStarted = Promise.withResolvers<void>()
    const firstGate = Promise.withResolvers<number>()
    const secondStarted = Promise.withResolvers<void>()
    const secondGate = Promise.withResolvers<number>()
    const thirdGate = Promise.withResolvers<number>()
    let reads = 0
    const onIdle = mock(() => {})

    const queue = createReadQueue(() => {
      reads += 1
      if (reads === 1) {
        firstStarted.resolve()
        return firstGate.promise
      }
      if (reads === 2) {
        secondStarted.resolve()
        return secondGate.promise
      }
      return thirdGate.promise
    }, onIdle)

    const first = queue.read()
    await firstStarted.promise
    expect(reads).toBe(1)

    const second = queue.read()
    const third = queue.read()
    expect(third).toBe(second)
    expect(second).not.toBe(first)
    expect(reads).toBe(1)
    expect(queue.contended()).toBe(true)

    firstGate.resolve(1)
    expect(await first).toBe(1)

    await secondStarted.promise
    expect(reads).toBe(2)

    const fourth = queue.read()
    expect(fourth).not.toBe(second)

    secondGate.resolve(2)
    expect(await Promise.all([second, third])).toEqual([2, 2])

    thirdGate.resolve(3)
    expect(await fourth).toBe(3)
    await queue.settled()
    await Promise.resolve()
    expect(reads).toBe(3)
    expect(queue.contended()).toBe(false)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })
})
