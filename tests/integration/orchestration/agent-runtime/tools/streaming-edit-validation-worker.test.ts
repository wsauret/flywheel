import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { canonicalMutationPath, withMutationQueueKey } from "../../../../../src/infra/file-mutation-queue.js"
import { terminateWorker } from "../../../../../src/infra/worker-termination.js"
import { createEditDefinition } from "../../../../../src/orchestration/agent-runtime/tools/edit.js"
import { createStreamingEditValidationService } from "../../../../../src/orchestration/agent-runtime/tools/streaming-edit-validation.js"
import type { StreamingEditValidationWorkerReply, StreamingEditValidationWorkerRequest } from "../../../../../src/orchestration/agent-runtime/tools/streaming-edit-validation-protocol.js"

function nextResult(worker: Worker): Promise<StreamingEditValidationWorkerReply> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<StreamingEditValidationWorkerReply>) => {
      if (event.data.type === "ready") return
      cleanup()
      resolve(event.data)
    }
    const onError = (event: ErrorEvent) => { cleanup(); reject(event.error ?? new Error(event.message)) }
    const cleanup = () => {
      worker.removeEventListener("message", onMessage)
      worker.removeEventListener("error", onError)
    }
    worker.addEventListener("message", onMessage)
    worker.addEventListener("error", onError)
  })
}

describe("streaming edit validation worker", () => {
  test("validates both tools from closed read-only snapshots without creating targets", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel validation worker "))
    const existing = join(root, "existing.txt")
    const missing = join(root, "missing", "new.txt")
    writeFileSync(existing, "alpha\nbeta\n")
    const worker = new Worker(new URL("../../../../../src/orchestration/agent-runtime/tools/streaming-edit-validation-worker.ts", import.meta.url), { name: "streaming-edit-validation-test" })
    try {
      const editResult = nextResult(worker)
      worker.postMessage({
        type: "append",
        handleToken: "edit-one",
        attemptToken: "attempt",
        toolToken: "edit",
        inputToken: "one",
        tool: "edit",
        executionCwd: root,
        sequence: 1,
        suffix: JSON.stringify({ path: "existing.txt", old_string: "absent", new_string: "value" }),
      } satisfies StreamingEditValidationWorkerRequest, [])
      expect(await editResult).toMatchObject({ type: "result", advice: { type: "set" } })

      const patchResult = nextResult(worker)
      worker.postMessage({
        type: "append",
        handleToken: "patch-two",
        attemptToken: "attempt",
        toolToken: "patch",
        inputToken: "two",
        tool: "apply_patch",
        executionCwd: root,
        sequence: 1,
        suffix: JSON.stringify({ input: `*** Begin Patch\n*** Add File: ${missing}\n+hello\n*** End Patch\n` }),
      } satisfies StreamingEditValidationWorkerRequest, [])
      expect(await patchResult).toMatchObject({ type: "result", advice: { type: "clear" } })
      expect(await Bun.file(missing).exists()).toBe(false)
    } finally {
      await terminateWorker(worker)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("binary snapshots make optional validation unavailable rather than failing the worker", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel validation binary "))
    writeFileSync(join(root, "binary.dat"), Buffer.from([0xff, 0xfe]))
    const worker = new Worker(new URL("../../../../../src/orchestration/agent-runtime/tools/streaming-edit-validation-worker.ts", import.meta.url), { name: "streaming-edit-validation-binary-test" })
    try {
      const result = nextResult(worker)
      worker.postMessage({
        type: "append",
        handleToken: "binary",
        attemptToken: "attempt",
        toolToken: "edit",
        inputToken: "binary",
        tool: "edit",
        executionCwd: root,
        sequence: 1,
        suffix: JSON.stringify({ path: "binary.dat", old_string: "x", new_string: "y" }),
      } satisfies StreamingEditValidationWorkerRequest, [])
      expect(await result).toEqual({
        type: "result",
        handleToken: "binary",
        attemptToken: "attempt",
        toolToken: "edit",
        inputToken: "binary",
        sequence: 1,
        status: "unavailable",
        advice: { type: "clear" },
      })
    } finally {
      await terminateWorker(worker)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("retains large snapshots within the aggregate budget and releases them on drop and unavailability", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel validation budget "))
    const content = `${"x".repeat(9 * 1024 * 1024)}\nneedle\n`
    writeFileSync(join(root, "first.txt"), content)
    writeFileSync(join(root, "second.txt"), content)
    const worker = new Worker(new URL("../../../../../src/orchestration/agent-runtime/tools/streaming-edit-validation-worker.ts", import.meta.url), { name: "streaming-edit-validation-budget-test" })
    const append = async (handleToken: string, path: string): Promise<StreamingEditValidationWorkerReply> => {
      const result = nextResult(worker)
      worker.postMessage({
        type: "append",
        handleToken,
        attemptToken: "attempt",
        toolToken: handleToken,
        inputToken: "input",
        tool: "edit",
        executionCwd: root,
        sequence: 1,
        suffix: JSON.stringify({ path, old_string: "needle", new_string: "replacement" }),
      } satisfies StreamingEditValidationWorkerRequest, [])
      return result
    }
    try {
      expect(await append("first", "first.txt")).toMatchObject({ type: "result", status: "clear", advice: { type: "clear" } })
      expect(await append("second", "second.txt")).toMatchObject({ type: "result", status: "unavailable", advice: { type: "clear" } })
      worker.postMessage({
        type: "drop",
        handleToken: "first",
        attemptToken: "attempt",
        toolToken: "first",
        inputToken: "input",
      } satisfies StreamingEditValidationWorkerRequest, [])
      expect(await append("third", "second.txt")).toMatchObject({ type: "result", status: "clear", advice: { type: "clear" } })
    } finally {
      await terminateWorker(worker)
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  test("final execution replans a stale preview snapshot and CAS refuses a later race", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel validation stale preview "))
    const path = join(root, "target.txt")
    writeFileSync(path, "preview snapshot\n")
    const firstAdvice = Promise.withResolvers<{ advice: { type: string; message?: string } }>()
    const service = createStreamingEditValidationService()
    try {
      const turn = service.openTurn({ executionCwd: root, onAdvice: event => firstAdvice.resolve(event) })
      const identity = { attemptToken: "stale", toolToken: "edit", inputToken: "target" }
      const input = { path: "target.txt", edits: [{ old_string: "current snapshot", new_string: "published" }] }
      turn.start({ ...identity, tool: "edit" })
      turn.append({ ...identity, suffix: JSON.stringify(input) })
      expect(await firstAdvice.promise).toMatchObject({ advice: { type: "set", message: expect.stringContaining("no match") } })

      writeFileSync(path, "current snapshot\n")
      const queued = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const holder = withMutationQueueKey(canonicalMutationPath(path), async () => {
        queued.resolve()
        await release.promise
      })
      await queued.promise
      const editing = createEditDefinition().execute(input, {
        executionCwd: root,
        userDataRoot: `${root}/.test-account`, projectRoot: root,
        artifactScopeId: "stale-preview",
        retrievalSessionId: "stale-preview",
      })
      await Promise.resolve()
      writeFileSync(path, "publication race\n")
      release.resolve()
      const result = await editing
      await holder

      expect(result).toMatchObject({ outcome: "error", content: expect.stringContaining("change was not applied") })
      expect(typeof result.content === "string" ? result.content : JSON.stringify(result.content)).not.toContain("no match")
      expect(await Bun.file(path).text()).toBe("publication race\n")
    } finally {
      await service.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
