import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { EventBus } from "../src/infra/event-bus"
import { HeadlessAdapter } from "../src/orchestration/headless/headless-adapter"
import type { FlywheelEvent } from "../src/infra/events"

const ts = "2026-01-01T00:00:00Z"
const wfId = "wf-headless-1"

// ---------------------------------------------------------------------------
// HeadlessAdapter — production module tests
// ---------------------------------------------------------------------------

describe("HeadlessAdapter (production)", () => {
  let bus: EventBus
  let logs: string[]
  let adapter: HeadlessAdapter

  beforeEach(() => {
    bus = new EventBus()
    logs = []
  })

  afterEach(() => {
    if (adapter?.isConnected()) {
      adapter.disconnect()
    }
  })

  // ── Lifecycle ──

  describe("lifecycle", () => {
    it("connects to EventBus, starts, handles events, stops, disconnects", () => {
      adapter = new HeadlessAdapter({
        logLevel: "normal",
        timestamps: false,
        logger: (msg) => logs.push(msg),
      })

      adapter.connect(bus)
      expect(adapter.isConnected()).toBe(true)

      adapter.start()
      expect(adapter.isRunning()).toBe(true)

      // Emit an event — should be logged
      bus.emit({
        type: "queue:initialized",
        workflowId: wfId,
        stepIds: ["s1", "s2"],
        timestamp: ts,
      })
      expect(logs.some((l) => l.includes("Queue initialized"))).toBe(true)

      adapter.stop()
      expect(adapter.isRunning()).toBe(false)

      adapter.disconnect()
      expect(adapter.isConnected()).toBe(false)
    })
  })

  // ── Log file output ──

  describe("log file output", () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "headless-test-"))
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it("writes logs to file non-blockingly", async () => {
      const logFile = path.join(tmpDir, "test.log")
      adapter = new HeadlessAdapter({
        logFile,
        logLevel: "normal",
        timestamps: false,
      })

      adapter.connect(bus)
      adapter.start()

      bus.emit({
        type: "queue:initialized",
        workflowId: wfId,
        stepIds: ["s1"],
        timestamp: ts,
      })

      adapter.stop()
      // Wait for the stream to fully flush before reading
      await adapter.closeLogStream()
      adapter.disconnect()

      const content = fs.readFileSync(logFile, "utf-8")
      expect(content).toContain("Queue initialized")
      expect(content).toContain("Workflow adapter started")
      expect(content).toContain("Workflow adapter stopped")
    })
  })

  // ── Console output via custom logger ──

  describe("console output", () => {
    it("uses custom logger when provided", () => {
      adapter = new HeadlessAdapter({
        logLevel: "normal",
        timestamps: false,
        logger: (msg) => logs.push(msg),
      })
      adapter.connect(bus)
      adapter.start()

      bus.emit({
        type: "queue:completed",
        workflowId: wfId,
        stepsCompleted: 3,
        timestamp: ts,
      })

      expect(logs.some((l) => l.includes("Queue completed (3 steps)"))).toBe(true)
    })
  })

  // ── Log levels ──

  describe("log levels", () => {
    it("minimal: only logs lifecycle + errors", () => {
      adapter = new HeadlessAdapter({
        logLevel: "minimal",
        timestamps: false,
        logger: (msg) => logs.push(msg),
      })
      adapter.connect(bus)
      adapter.start()

      // This should NOT be logged at minimal level
      bus.emit({
        type: "subprocess:spawned",
        workflowId: wfId,
        stepIndex: 0,
        timestamp: ts,
      })

      // This SHOULD be logged (errors always logged)
      bus.emit({
        type: "subprocess:failed",
        workflowId: wfId,
        failure: { type: "timeout", message: "timed out" },
        timestamp: ts,
      })

      const nonLifecycleLogs = logs.filter(
        (l) => !l.includes("adapter started") && !l.includes("adapter stopped")
      )
      expect(nonLifecycleLogs).toHaveLength(1)
      expect(nonLifecycleLogs[0]).toContain("FAILED")
    })

    it("normal: logs step events and output", () => {
      adapter = new HeadlessAdapter({
        logLevel: "normal",
        timestamps: false,
        logger: (msg) => logs.push(msg),
      })
      adapter.connect(bus)
      adapter.start()

      bus.emit({
        type: "subprocess:spawned",
        workflowId: wfId,
        stepIndex: 0,
        timestamp: ts,
      })

      // dispatcher:invoked should NOT appear at normal (verbose only)
      bus.emit({
        type: "dispatcher:invoked",
        workflowId: wfId,
        stepIndex: 0,
        timestamp: ts,
      })

      const hasSpawned = logs.some((l) => l.includes("Subprocess spawned"))
      const hasDispatcher = logs.some((l) => l.includes("Dispatcher invoked"))
      expect(hasSpawned).toBe(true)
      expect(hasDispatcher).toBe(false)
    })

    it("verbose: logs dispatcher/evaluator + trace events", () => {
      adapter = new HeadlessAdapter({
        logLevel: "verbose",
        timestamps: false,
        logger: (msg) => logs.push(msg),
      })
      adapter.connect(bus)
      adapter.start()

      bus.emit({
        type: "dispatcher:invoked",
        workflowId: wfId,
        stepIndex: 0,
        timestamp: ts,
      })

      bus.emit({
        type: "trace:tool-started",
        workflowId: wfId,
        toolUseId: "tu-1",
        toolName: "Read",
        toolInput: '{"path": "/foo"}',
        timestamp: ts,
      })

      bus.emit({
        type: "trace:tool-completed",
        workflowId: wfId,
        toolUseId: "tu-1",
        toolOutput: "file contents",
        isError: false,
        timestamp: ts,
      })

      bus.emit({
        type: "trace:subagent-started",
        workflowId: wfId,
        toolUseId: "tu-2",
        agentType: "code-review",
        description: "Review code",
        prompt: "Review this",
        timestamp: ts,
      })

      bus.emit({
        type: "trace:subagent-completed",
        workflowId: wfId,
        toolUseId: "tu-2",
        result: "Looks good",
        isError: false,
        timestamp: ts,
      })

      expect(logs.some((l) => l.includes("Dispatcher invoked"))).toBe(true)
      expect(logs.some((l) => l.includes("Trace: tool started"))).toBe(true)
      expect(logs.some((l) => l.includes("Trace: tool completed"))).toBe(true)
      expect(logs.some((l) => l.includes("Trace: subagent started"))).toBe(true)
      expect(logs.some((l) => l.includes("Trace: subagent completed"))).toBe(true)
    })

    it("trace events are NOT logged at normal level", () => {
      adapter = new HeadlessAdapter({
        logLevel: "normal",
        timestamps: false,
        logger: (msg) => logs.push(msg),
      })
      adapter.connect(bus)
      adapter.start()

      bus.emit({
        type: "trace:tool-started",
        workflowId: wfId,
        toolUseId: "tu-1",
        toolName: "Read",
        toolInput: '{"path": "/foo"}',
        timestamp: ts,
      })

      expect(logs.some((l) => l.includes("Trace:"))).toBe(false)
    })
  })

  // ── disconnect() closes logStream ──

  describe("disconnect() stream cleanup", () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "headless-dc-"))
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it("disconnect() closes logStream even if stop() was not called", async () => {
      const logFile = path.join(tmpDir, "leak.log")
      adapter = new HeadlessAdapter({
        logFile,
        logLevel: "normal",
        timestamps: false,
      })

      adapter.connect(bus)
      adapter.start()

      bus.emit({
        type: "queue:initialized",
        workflowId: wfId,
        stepIds: ["s1"],
        timestamp: ts,
      })

      // Wait for stream to flush, then disconnect (skipping stop())
      await adapter.closeLogStream()
      adapter.disconnect()
      expect(adapter.isConnected()).toBe(false)

      // The log file should have been flushed
      const content = fs.readFileSync(logFile, "utf-8")
      expect(content).toContain("Queue initialized")
    })
  })
})
