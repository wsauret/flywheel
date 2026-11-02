import { describe, expect, it } from "bun:test"

import type { AgentStreamEvent } from "../../../../../src/orchestration/agent-runtime/types.ts"
import { createExperimentChatObserver } from "../../../../../src/orchestration/modules/experiments/chat-observer.ts"
import type { ExperimentSnapshot } from "../../../../../src/orchestration/modules/experiments/projection.ts"
import type { ExperimentFact } from "../../../../../src/orchestration/modules/experiments/facts.ts"

function snapshot(overrides: Partial<ExperimentSnapshot> = {}): ExperimentSnapshot {
  return {
    mode: { active: true, workDir: "/repo" },
    configuration: {
      segment: 0,
      name: "speed",
      metricName: "time",
      metricUnit: "ms",
      direction: "lower",
      measureCommand: "./.experiment/measure.sh",
      checksCommand: null,
      workDir: "/repo",
      maxIterations: null,
      protectedPaths: [],
      sealedPaths: [],
    },
    segments: [],
    runs: [],
    currentSegment: 0,
    secondaryMetrics: [],
    resumedTurns: 0,
    baselineMetric: null,
    bestMetric: null,
    confidence: null,
    protectedPaths: [],
    sealedPaths: [],
    ...overrides,
  }
}

const runEvent: AgentStreamEvent = {
  type: "tool_use",
  toolUseId: "run-1",
  toolName: "run_experiment",
  toolInput: {},
}

function harness(initial: ExperimentSnapshot | undefined = snapshot()) {
  let current: ExperimentSnapshot | undefined = initial
  const facts: ExperimentFact[] = []
  const silent: string[] = []
  const visible: string[] = []
  const observer = createExperimentChatObserver({
    replay: async () => current,
    record: async (fact) => { facts.push(fact) },
    enqueueSilentSystem: (message) => { silent.push(message) },
    showSystemMessage: (message) => { visible.push(message) },
  })
  return {
    observer,
    facts,
    silent,
    visible,
    setSnapshot(next: ExperimentSnapshot | undefined) { current = next },
  }
}

describe("experiment chat observer", () => {
  it("continues only a turn that called run_experiment", async () => {
    const h = harness()

    await h.observer.onTurnComplete("turn_end")
    expect(h.facts).toEqual([])

    h.observer.onEvent(runEvent)
    await h.observer.onTurnComplete("turn_end")
    expect(h.facts.map((fact) => fact.type)).toEqual(["experiment.resumed"])
    expect(h.facts[0]?.payload).toEqual({ turn: 1, reason: "turn_end" })
    expect(h.silent).toHaveLength(1)
    expect(h.silent[0]).toContain("<experiment_resume>")
    expect(h.silent[0]).toContain("Run the next iteration now.")

    await h.observer.onTurnComplete("turn_end")
    expect(h.facts).toHaveLength(1)
  })

  it("ignores inactive state and stops on each durable guard", async () => {
    const cases: Array<{ state: ExperimentSnapshot; reason: string }> = [
      { state: snapshot({ resumedTurns: 200 }), reason: "Experiment auto-resume limit reached (200 turns)" },
      {
        state: snapshot({
          runs: Array.from({ length: 21 }, (_, run) => ({
            run: run + 1,
            segment: 0,
            commit: "-------",
            metric: 10,
            metrics: {},
            status: "discard" as const,
            description: "failed",
            timestamp: run,
            confidence: null,
            durationMs: null,
          })),
        }),
        reason: "Experiment auto-resume stopped: 21 consecutive discards/crashes",
      },
      {
        state: snapshot({
          configuration: { ...snapshot().configuration!, maxIterations: 1 },
          runs: [{ run: 1, segment: 0, commit: "abc1234", metric: 9, metrics: {}, status: "keep", description: "kept", timestamp: 1, confidence: null, durationMs: null }],
        }),
        reason: "Maximum experiments reached (1). The experiment loop is done.",
      },
    ]

    for (const item of cases) {
      const h = harness(item.state)
      h.observer.onEvent(runEvent)
      await h.observer.onTurnComplete("turn_end")
      expect(h.facts.map((fact) => fact.type)).toEqual(["experiment.mode.changed"])
      expect(h.facts[0]?.payload).toEqual({ active: false, workDir: item.state.mode.workDir })
      expect(h.visible).toEqual([item.reason])
      expect(h.silent).toEqual([])
    }

    const inactive = harness(snapshot({ mode: { active: false, workDir: "/repo" } }))
    inactive.observer.onEvent(runEvent)
    await inactive.observer.onTurnComplete("turn_end")
    expect(inactive.facts).toEqual([])
  })

  it("records compaction continuation before enqueueing its exact silent envelope", async () => {
    const order: string[] = []
    const observer = createExperimentChatObserver({
      replay: async () => snapshot({ resumedTurns: 4 }),
      record: async (fact) => {
        order.push(`record:${fact.type}:${fact.type === "experiment.resumed" ? fact.payload.reason : ""}`)
      },
      enqueueSilentSystem: (message) => { order.push(`enqueue:${message}`) },
      showSystemMessage: () => {},
    })

    await observer.onCompactionContinuation()

    expect(order[0]).toBe("record:experiment.resumed:compaction")
    expect(order[1]).toContain("<experiment_resume>")
    expect(order[1]).toContain("Re-read .experiment/charter.md after compaction")
  })
})
