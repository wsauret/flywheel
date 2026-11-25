import { describe, expect, it } from "bun:test"

import { createEmit, EventBus } from "../../../../../src/infra/substrate/events/event-bus.ts"
import type { ToolCallEventData } from "../../../../../src/infra/substrate/runtime-facts/runtime-event-payload-types.ts"
import { createModuleChatObservers } from "../../../../../src/orchestration/chat/lifecycle/module-observers.ts"
import type { ModuleChatObserverContext } from "../../../../../src/orchestration/module-seams.ts"
import { composeFirstPartyModules, SHIPPED_MODULES } from "../../../../../src/orchestration/modules.ts"
import { createTestChatSessionDeps } from "../../chat/_chat-session-agent-runtime-fixtures.ts"
import { createExperimentChatObserver } from "../../../../../src/orchestration/modules/experiments/chat-observer.ts"
import type { ExperimentSnapshot } from "../../../../../src/orchestration/modules/experiments/state/projection.js"
import type { ExperimentFact } from "../../../../../src/orchestration/modules/experiments/state/facts.js"

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
    guardRevision: 2,
    ...overrides,
  }
}

const runToolUse: ToolCallEventData["tool_use"] = { id: "run-1", name: "run_experiment", input: {} }

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

    h.observer.onToolInput(runToolUse)
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
      h.observer.onToolInput(runToolUse)
      await h.observer.onTurnComplete("turn_end")
      expect(h.facts.map((fact) => fact.type)).toEqual(["experiment.mode.changed"])
      expect(h.facts[0]?.payload).toEqual({ active: false, workDir: item.state.mode.workDir })
      expect(h.visible).toEqual([item.reason])
      expect(h.silent).toEqual([])
    }

    const inactive = harness(snapshot({ mode: { active: false, workDir: "/repo" } }))
    inactive.observer.onToolInput(runToolUse)
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

/** The chat observer seam as a chat builds it: the shipped catalog, with the
 *  experiments observer counting the tool inputs that reach it. */
function chatSeam(options: { readonly experiments: boolean }) {
  const toolInputs: string[] = []
  const catalog = SHIPPED_MODULES.map((module) => module.id !== "experiments" ? module : {
    ...module,
    observers: module.observers.map((entry) => ({
      ...entry,
      observer: (context: ModuleChatObserverContext) => {
        const observer = entry.observer(context)
        return { ...observer, onToolInput: (toolUse: ToolCallEventData["tool_use"]) => { toolInputs.push(toolUse.id); observer.onToolInput?.(toolUse) } }
      },
    })),
  })
  const composition = composeFirstPartyModules(catalog, options.experiments ? [] : ["experiments"])
  const deps = createTestChatSessionDeps({ sessionId: "experiment-seam", createAgent: () => { throw new Error("the seam starts no runner") } })
  const bus = new EventBus()
  const subscribed: string[] = []
  const observers = createModuleChatObservers(() => composition, {
    sessionId: deps.sessionId, eventStore: deps.infra.eventStore, projectionReader: deps.infra.eventStore,
    writer: deps.infra.sessionEventWriter, enqueueSilentSystem: () => {}, showSystemMessage: () => {},
  }, {
    subscribeToType(type, listener, subscription) {
      subscribed.push(type)
      return bus.subscribeToType(type, listener, subscription)
    },
  })
  return { bus, emit: createEmit(bus), observers, subscribed, toolInputs }
}

describe("experiment chat observer seam", () => {
  it("A completed tool input reaches the experiments observer once; 500 text deltas in the same turn reach it zero times", async () => {
    const seam = chatSeam({ experiments: true })
    expect(seam.subscribed).toEqual(["tool.input.completed"])

    for (let index = 0; index < 250; index++) {
      seam.emit("model.content.delta", { sessionId: "experiment-seam", data: { delta: { type: "text_delta", text: "x" }, block_key: "answer" } })
    }
    seam.emit("tool.input.completed", { sessionId: "experiment-seam", data: { tool_use: runToolUse } })
    seam.emit("tool.input.completed", { sessionId: "experiment-seam", data: { tool_use: { id: "nested-1", name: "run_experiment", input: {} }, parent_tool_use_id: "agent-1" } })
    for (let index = 0; index < 250; index++) {
      seam.emit("model.content.delta", { sessionId: "experiment-seam", data: { delta: { type: "text_delta", text: "x" }, block_key: "answer" } })
    }
    await seam.bus.drain()

    expect(seam.toolInputs).toEqual(["run-1"])
    await seam.observers.onTurnComplete("turn_end")
    expect(seam.subscribed).toEqual(["tool.input.completed"])
    await seam.observers.dispose()
    await seam.bus.dispose()
  })

  it("With the experiments module off, the session subscribes to no runtime event for observers", async () => {
    const seam = chatSeam({ experiments: false })
    seam.emit("tool.input.completed", { sessionId: "experiment-seam", data: { tool_use: runToolUse } })
    await seam.bus.drain()
    await seam.observers.onTurnComplete("turn_end")

    expect(seam.subscribed).toEqual([])
    expect(seam.toolInputs).toEqual([])
    await seam.observers.dispose()
    await seam.bus.dispose()
  })
})
