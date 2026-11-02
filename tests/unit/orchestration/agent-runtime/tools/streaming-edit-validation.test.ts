import { describe, expect, test } from "bun:test"
import { MAX_STREAMING_TOOL_INPUT_BYTES } from "../../../../../src/infra/output/partial-json.js"
import { completeRuntimeToolSurfaces } from "../../../../../src/orchestration/agent-runtime/factory.js"
import { deriveChildRuntimeSurfaces } from "../../../../../src/orchestration/agent-runtime/tools/tool-registry.js"
import { createStreamingEditValidationService, type StreamingEditValidationService, type StreamingEditValidationWorker } from "../../../../../src/orchestration/agent-runtime/tools/streaming-edit-validation.js"
import type { StreamingEditValidationWorkerReply, StreamingEditValidationWorkerRequest } from "../../../../../src/orchestration/agent-runtime/tools/streaming-edit-validation-protocol.js"

class ControlledWorker extends EventTarget {
  onmessage: StreamingEditValidationWorker["onmessage"] = null
  readonly messages: StreamingEditValidationWorkerRequest[] = []
  terminated = false

  postMessage(message: StreamingEditValidationWorkerRequest, _transfer: Transferable[]): void {
    this.messages.push(message)
  }

  reply(message: StreamingEditValidationWorkerReply): void {
    this.onmessage?.(new MessageEvent("message", { data: message }))
  }

  terminate(): void {
    this.terminated = true
    this.dispatchEvent(new Event("close"))
  }
}

const identity = { attemptToken: "attempt-1", toolToken: "tool-1", inputToken: "input-1" }

describe("streaming edit validation service", () => {
  test("starts lazily and coalesces ordered suffixes behind one global batch", async () => {
    const worker = new ControlledWorker()
    let starts = 0
    const service = createStreamingEditValidationService({
      spawnWorker: (): StreamingEditValidationWorker => { starts += 1; return worker },
      workerSpecifier: "worker.ts",
    })
    const advice: unknown[] = []
    const turn = service.openTurn({ executionCwd: "/repo", onAdvice: (value) => advice.push(value) })
    turn.start({ ...identity, tool: "edit" })
    expect(starts).toBe(0)

    turn.append({ ...identity, suffix: "a" })
    await Promise.resolve()
    await Promise.resolve()
    turn.append({ ...identity, suffix: "b" })
    turn.append({ ...identity, suffix: "c" })
    expect(starts).toBe(1)
    expect(worker.messages).toHaveLength(1)
    expect(worker.messages[0]).toMatchObject({ type: "append", sequence: 1, suffix: "a" })

    const firstRequest = worker.messages[0]
    if (firstRequest?.type !== "append") throw new Error("expected append")
    worker.reply({ ...firstRequest, type: "result", status: "clear", advice: { type: "clear" } })
    expect(worker.messages).toHaveLength(2)
    expect(worker.messages[1]).toMatchObject({ type: "append", sequence: 2, suffix: "bc" })
    const secondRequest = worker.messages[1]
    if (secondRequest?.type !== "append") throw new Error("expected append")
    worker.reply({ ...secondRequest, type: "result", status: "advisory", advice: { type: "set", message: "no match" } })
    expect(advice).toEqual([
      { ...identity, advice: { type: "clear" } },
      { ...identity, advice: { type: "set", message: "no match" } },
    ])

    await service.dispose()
    expect(worker.terminated).toBe(true)
  })

  test("retires tokens synchronously and drops stale replies and queued suffixes", async () => {
    const worker = new ControlledWorker()
    const received: unknown[] = []
    const service = createStreamingEditValidationService({ spawnWorker: () => worker, workerSpecifier: "worker.ts" })
    const turn = service.openTurn({ executionCwd: "/repo", onAdvice: (value) => received.push(value) })
    turn.start({ ...identity, tool: "apply_patch" })
    turn.append({ ...identity, suffix: "one" })
    await Promise.resolve()
    await Promise.resolve()
    turn.append({ ...identity, suffix: "two" })
    turn.retire(identity)
    expect(worker.messages.at(-1)).toMatchObject({ type: "drop", ...identity, handleToken: expect.any(String) })
    const request = worker.messages[0]
    if (request?.type !== "append") throw new Error("expected append")
    worker.reply({ ...request, type: "result", status: "advisory", advice: { type: "set", message: "late" } })
    expect(received).toEqual([])
    expect(worker.messages.some((message) => message.type === "append" && message.suffix === "two")).toBe(false)

    turn.start({ ...identity, inputToken: "input-2", tool: "edit" })
    turn.append({ ...identity, inputToken: "input-2", suffix: "new" })
    expect(worker.messages.at(-1)).toMatchObject({ type: "append", inputToken: "input-2", suffix: "new" })
    await service.dispose()
  })

  test("processed input remains charged until its handle retires", async () => {
    const worker = new ControlledWorker()
    const service = createStreamingEditValidationService({ spawnWorker: () => worker, workerSpecifier: "worker.ts" })
    const first = service.openTurn({ executionCwd: "/repo", onAdvice: () => {} })
    const second = service.openTurn({ executionCwd: "/repo", onAdvice: () => {} })
    const otherIdentity = { attemptToken: "attempt-2", toolToken: "tool-2", inputToken: "input-2" }
    first.start({ ...identity, tool: "edit" })
    second.start({ ...otherIdentity, tool: "edit" })
    const half = "x".repeat(MAX_STREAMING_TOOL_INPUT_BYTES / 2)
    first.append({ ...identity, suffix: half })
    await Promise.resolve()
    await Promise.resolve()
    const firstRequest = worker.messages[0]
    if (firstRequest?.type !== "append") throw new Error("expected first append")
    worker.reply({ ...firstRequest, type: "result", status: "clear", advice: { type: "clear" } })
    first.append({ ...identity, suffix: half })
    const secondFirstRequest = worker.messages.at(-1)
    if (!secondFirstRequest || secondFirstRequest.type !== "append") throw new Error("expected second append")
    worker.reply({ ...secondFirstRequest, type: "result", status: "clear", advice: { type: "clear" } })

    second.append({ ...otherIdentity, suffix: "over budget" })
    expect(worker.messages.at(-1)).toMatchObject({ type: "drop", ...otherIdentity })
    first.retire(identity)
    second.start({ ...otherIdentity, tool: "edit" })
    second.append({ ...otherIdentity, suffix: "admitted after retirement" })
    expect(worker.messages.at(-1)).toMatchObject({ type: "append", suffix: "admitted after retirement" })
    await service.dispose()
  })

  test("isolates handles that reuse every caller identity token", async () => {
    const worker = new ControlledWorker()
    const firstAdvice: unknown[] = []
    const secondAdvice: unknown[] = []
    const service = createStreamingEditValidationService({ spawnWorker: () => worker, workerSpecifier: "worker.ts" })
    const first = service.openTurn({ executionCwd: "/first", onAdvice: value => firstAdvice.push(value) })
    const second = service.openTurn({ executionCwd: "/second", onAdvice: value => secondAdvice.push(value) })
    first.start({ ...identity, tool: "edit" })
    second.start({ ...identity, tool: "edit" })

    first.append({ ...identity, suffix: "first" })
    await Promise.resolve()
    await Promise.resolve()
    second.append({ ...identity, suffix: "second" })
    const firstRequest = worker.messages[0]
    expect(firstRequest).toMatchObject({ type: "append", executionCwd: "/first", suffix: "first" })
    if (firstRequest?.type !== "append") throw new Error("expected first append")
    worker.reply({ ...firstRequest, type: "result", status: "advisory", advice: { type: "set", message: "first advice" } })
    const secondRequest = worker.messages.at(-1)
    expect(secondRequest).toMatchObject({ type: "append", executionCwd: "/second", suffix: "second" })
    if (!secondRequest || secondRequest.type !== "append") throw new Error("expected second append")
    expect(secondRequest.handleToken).not.toBe(firstRequest.handleToken)
    worker.reply({ ...secondRequest, type: "result", status: "advisory", advice: { type: "set", message: "second advice" } })

    expect(firstAdvice).toEqual([{ ...identity, advice: { type: "set", message: "first advice" } }])
    expect(secondAdvice).toEqual([{ ...identity, advice: { type: "set", message: "second advice" } }])
    first.retire(identity)
    expect(worker.messages.at(-1)).toMatchObject({ type: "drop", handleToken: firstRequest.handleToken })
    second.append({ ...identity, suffix: "still live" })
    expect(worker.messages.at(-1)).toMatchObject({ type: "append", handleToken: secondRequest.handleToken, suffix: "still live" })
    await service.dispose()
  })

  test("worker failure is nonblocking and dispose joins lazy startup", async () => {
    let releaseStart: (() => void) | undefined
    const worker = new ControlledWorker()
    const service = createStreamingEditValidationService({
      spawnWorker: async () => {
        await new Promise<void>((resolve) => { releaseStart = resolve })
        return worker
      },
      workerSpecifier: "worker.ts",
    })
    const turn = service.openTurn({ executionCwd: "/repo", onAdvice: () => { throw new Error("unexpected advice") } })
    turn.start({ ...identity, tool: "edit" })
    expect(() => turn.append({ ...identity, suffix: "x" })).not.toThrow()
    await Promise.resolve()
    const disposing = service.dispose()
    releaseStart?.()
    await disposing
    expect(worker.terminated).toBe(true)
    expect(() => turn.append({ ...identity, suffix: "y" })).not.toThrow()
  })

  test("flooded handles share one global worker batch and enforce the queued-byte ceiling", async () => {
    const worker = new ControlledWorker()
    const service = createStreamingEditValidationService({ spawnWorker: () => worker, workerSpecifier: "worker.ts" })
    const turns = Array.from({ length: 24 }, (_, index) => {
      const turn = service.openTurn({ executionCwd: "/repo", onAdvice: () => {} })
      const floodIdentity = { attemptToken: "flood", toolToken: `tool-${index}`, inputToken: `input-${index}` }
      turn.start({ ...floodIdentity, tool: "edit" })
      return { turn, identity: floodIdentity }
    })
    const fragment = "x".repeat(256 * 1024)
    for (const { turn, identity: floodIdentity } of turns) turn.append({ ...floodIdentity, suffix: fragment })
    await Promise.resolve()
    await Promise.resolve()
    expect(worker.messages.filter(message => message.type === "append")).toHaveLength(1)

    let postedBytes = 0
    let maximumPostedBatchBytes = 0
    while (true) {
      const request = worker.messages.at(-1)
      if (!request || request.type !== "append") break
      const bytes = Buffer.byteLength(request.suffix)
      postedBytes += bytes
      maximumPostedBatchBytes = Math.max(maximumPostedBatchBytes, bytes)
      worker.reply({ ...request, type: "result", status: "clear", advice: { type: "clear" } })
      if (worker.messages.at(-1) === request) break
    }
    expect(maximumPostedBatchBytes).toBeLessThanOrEqual(MAX_STREAMING_TOOL_INPUT_BYTES)
    expect(postedBytes).toBeLessThanOrEqual(MAX_STREAMING_TOOL_INPUT_BYTES)
    await service.dispose()
  })
})

describe("streaming edit validation runtime ownership", () => {
  test("preserves the runtime-owned service identity through hosted and child surfaces", () => {
    const validation = {
      openTurn: () => ({ start: () => {}, append: () => {}, retire: () => {}, reset: () => {} }),
      dispose: async () => {},
    } satisfies StreamingEditValidationService
    const hosted = completeRuntimeToolSurfaces({}, { streamingEditValidation: validation })
    const child = deriveChildRuntimeSurfaces(hosted)

    expect(hosted.streamingEditValidation).toBe(validation)
    expect(child.streamingEditValidation).toBe(validation)
  })
})
