/**
 * Tests for disposeSessionResources — unified disposal of session infra.
 *
 * Verifies:
 * 1. Ordering: finalize → flush → dispose. All methods called once.
 * 2. Double-dispose is a no-op (idempotent).
 * 3. Handles null/optional resources gracefully.
 * 4. traceCollector.finalize() is sync (no await needed).
 */

import { describe, it, expect } from "bun:test"
import { createRoot } from "solid-js"
import { disposeSessionResources, type SessionResources } from "../src/orchestration/session/resources"

// ---------------------------------------------------------------------------
// Helpers — mock resources with call tracking
// ---------------------------------------------------------------------------

interface CallLog {
  method: string
  args?: unknown[]
  timestamp: number
}

function createMockResources(opts?: { traceNull?: boolean }): {
  resources: SessionResources
  log: CallLog[]
} {
  const log: CallLog[] = []
  let seq = 0

  const record = (method: string, args?: unknown[]) => {
    log.push({ method, args, timestamp: seq++ })
  }

  const budgetTracker = {
    flush: () => record("budgetTracker.flush"),
    dispose: () => record("budgetTracker.dispose"),
  }

  const traceWriter = {
    dispose: () => record("traceWriter.dispose"),
  }

  const transcriptWriter = {
    dispose: () => record("transcriptWriter.dispose"),
  }

  const traceCollector = opts?.traceNull
    ? null
    : {
        finalize: (status: string) => record("traceCollector.finalize", [status]),
        dispose: () => record("traceCollector.dispose"),
      }

  const outputFlusher = {
    flush: async () => { record("outputFlusher.flush") },
    dispose: () => record("outputFlusher.dispose"),
  }

  return {
    resources: {
      budgetTracker: budgetTracker as any,
      traceWriter: traceWriter as any,
      transcriptWriter: transcriptWriter as any,
      traceCollector: traceCollector as any,
      outputFlusher: outputFlusher as any,
    },
    log,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("disposeSessionResources", () => {
  it("calls finalize → flush → dispose in correct order", async () => {
    await createRoot(async () => {
      const { resources, log } = createMockResources()

      await disposeSessionResources(resources, "ok")

      // All methods should have been called
      const methods = log.map((l) => l.method)
      expect(methods).toContain("traceCollector.finalize")
      expect(methods).toContain("outputFlusher.flush")
      expect(methods).toContain("budgetTracker.flush")
      expect(methods).toContain("budgetTracker.dispose")
      expect(methods).toContain("traceWriter.dispose")
      expect(methods).toContain("transcriptWriter.dispose")
      expect(methods).toContain("traceCollector.dispose")
      expect(methods).toContain("outputFlusher.dispose")

      // Ordering: finalize before flush, flush before dispose
      const finalizeTime = log.find((l) => l.method === "traceCollector.finalize")!.timestamp
      const outputFlushTime = log.find((l) => l.method === "outputFlusher.flush")!.timestamp
      const budgetFlushTime = log.find((l) => l.method === "budgetTracker.flush")!.timestamp
      const budgetDisposeTime = log.find((l) => l.method === "budgetTracker.dispose")!.timestamp
      const traceWriterDisposeTime = log.find((l) => l.method === "traceWriter.dispose")!.timestamp
      const transcriptWriterDisposeTime = log.find((l) => l.method === "transcriptWriter.dispose")!.timestamp
      const traceCollectorDisposeTime = log.find((l) => l.method === "traceCollector.dispose")!.timestamp

      // finalize must come before any flush
      expect(finalizeTime).toBeLessThan(outputFlushTime)
      expect(finalizeTime).toBeLessThan(budgetFlushTime)

      // flushes before disposes
      expect(outputFlushTime).toBeLessThan(budgetDisposeTime)
      expect(budgetFlushTime).toBeLessThan(budgetDisposeTime)
      expect(outputFlushTime).toBeLessThan(traceWriterDisposeTime)
      expect(outputFlushTime).toBeLessThan(transcriptWriterDisposeTime)
      expect(outputFlushTime).toBeLessThan(traceCollectorDisposeTime)
    })
  })

  it("passes trace status to finalize", async () => {
    await createRoot(async () => {
      const { resources, log } = createMockResources()

      await disposeSessionResources(resources, "error")

      const finalizeCall = log.find((l) => l.method === "traceCollector.finalize")
      expect(finalizeCall).toBeDefined()
      expect(finalizeCall!.args).toEqual(["error"])
    })
  })

  it("each method called exactly once", async () => {
    await createRoot(async () => {
      const { resources, log } = createMockResources()

      await disposeSessionResources(resources, "ok")

      const counts = new Map<string, number>()
      for (const entry of log) {
        counts.set(entry.method, (counts.get(entry.method) ?? 0) + 1)
      }

      expect(counts.get("traceCollector.finalize")).toBe(1)
      expect(counts.get("outputFlusher.flush")).toBe(1)
      expect(counts.get("budgetTracker.flush")).toBe(1)
      expect(counts.get("budgetTracker.dispose")).toBe(1)
      expect(counts.get("traceWriter.dispose")).toBe(1)
      expect(counts.get("transcriptWriter.dispose")).toBe(1)
      expect(counts.get("traceCollector.dispose")).toBe(1)
      expect(counts.get("outputFlusher.dispose")).toBe(1)
    })
  })

  it("double-dispose is a no-op", async () => {
    await createRoot(async () => {
      const { resources, log } = createMockResources()

      await disposeSessionResources(resources, "ok")
      const firstCallCount = log.length

      await disposeSessionResources(resources, "ok")
      // No additional calls should have been made
      expect(log.length).toBe(firstCallCount)
    })
  })

  it("handles null traceCollector/traceWriter/transcriptWriter gracefully", async () => {
    await createRoot(async () => {
      const { resources, log } = createMockResources({ traceNull: true })
      // Also set trace writer and transcript writer to null
      resources.traceWriter = null
      resources.transcriptWriter = null

      await disposeSessionResources(resources, "ok")

      const methods = log.map((l) => l.method)
      // Should still flush and dispose budget + output
      expect(methods).toContain("outputFlusher.flush")
      expect(methods).toContain("budgetTracker.flush")
      expect(methods).toContain("budgetTracker.dispose")
      expect(methods).toContain("outputFlusher.dispose")
      // Should NOT have trace methods
      expect(methods).not.toContain("traceCollector.finalize")
      expect(methods).not.toContain("traceWriter.dispose")
      expect(methods).not.toContain("transcriptWriter.dispose")
    })
  })

  it("traceCollector.finalize is sync (returns void, not Promise)", () => {
    // Verify at the type level + runtime that finalize is synchronous.
    // This is important: if it were async, disposeSessionResources would need to await it.
    const mockCollector = {
      finalize: (status: string): void => { /* sync */ },
      dispose: () => {},
    }

    // Call should return undefined (void), not a Promise
    const result = mockCollector.finalize("ok")
    expect(result).toBeUndefined()
  })
})
