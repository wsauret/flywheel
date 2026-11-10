/**
 * Resilience tests for LLM session title generation: in-runner validation
 * retries with per-turn timeout budgets, truncation of persistently
 * over-limit titles, fresh-runner retry after transient failures, and
 * disposal abort of in-flight generation.
 */

import { describe, it, expect } from "bun:test"
import type { DebugLogRecordInput } from "../../../../../src/infra/debug-log.js"
import { Log } from "../../../../../src/infra/log.js"
import type { AgentRunResult, Agent, AgentFactory, AgentOptions } from "../../../../../src/orchestration/agent-runtime/types.js"
import { newTestRunner } from "../../../../helpers/agent-runner.js"
import {
  generateSessionTitle,
  SESSION_TITLE_PURPOSE,
  type SessionTitles,
} from "../../../../../src/orchestration/session/session-title.js"
import { renderSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"
import { makeCaptureClient } from "../context/_loop-fixtures.js"
import { testAuth as auth, titleRoots } from "../../../../fixtures/session-title-fixtures.js"

describe("generateSessionTitle — resilience", () => {
  function realRunnerFactory(turns: Array<string>): AgentFactory {
    const { client } = makeCaptureClient(turns.map((text) => ({
      events: [
        { kind: "text_delta" as const, text, blockKey: "text" },
        { kind: "done" as const, stopReason: "end_turn" },
      ],
    })))
    return (options: AgentOptions): Agent => newTestRunner(options, async () => client)
  }

  /** Resolves with the generated LLM title -- the second onTitle emission (the
   *  first is the synchronous quick title). Deterministic: every caller drives
   *  the runner to a title, so the second emission always arrives. A regression
   *  surfaces as bun's per-test timeout rather than a flaky `null` from a raced
   *  wall-clock timer. */
  async function titleFrom(createRunner: AgentFactory): Promise<SessionTitles | null> {
    let title: SessionTitles | null = null
    title = await new Promise<SessionTitles>((resolve) => {
      let emissions = 0
      generateSessionTitle(
        "exercise title generation resilience",
        (titles) => {
          emissions++
          if (emissions === 2) resolve(titles)
        },
        { createRunner, auth, ...titleRoots, model: "gpt-5-mini" },
      )
    })
    return title
  }

  it("retries in-runner when the title is over limit, then accepts the fix", async () => {
    const title = await titleFrom(realRunnerFactory([
      "TITLE: This title is definitely much longer than the character budget allows\nSHORT: Long",
      "TITLE: fixed title\nSHORT: fixed result",
    ]))
    expect(title).toEqual({ full: "fixed title", short: "Fixed Result" })
  })

  it("truncates a persistently over-limit title instead of discarding it", async () => {
    const longTitle = "Exhaustively Long Title That Never Ever Shrinks Below The Character Budget"
    const turn = `TITLE: ${longTitle}\nSHORT: Long`
    const title = await titleFrom(realRunnerFactory([turn, turn, turn]))
    expect(title).toEqual({ full: longTitle.slice(0, 46), short: "Long" })
  })

  it("records the model and title lengths but never the title text", async () => {
    const longTitle = "Confidential Merger Codename Bluebird Review Of The Acquisition Terms"
    const turn = `TITLE: ${longTitle}\nSHORT: Bluebird`
    const records: DebugLogRecordInput[] = []
    await Log.init({ forward: (record) => { records.push(record) } })
    try {
      const title = await titleFrom(realRunnerFactory([turn, turn, turn]))
      expect(title).toEqual({ full: longTitle.slice(0, 46), short: "Bluebird" })
    } finally {
      await Log.closeGlobal()
    }
    expect(records).toContainEqual({
      type: "log.info",
      payload: { service: "session-title", message: "generated session titles", model: "gpt-5-mini", fullLength: 46, shortLength: 8 },
    })
    expect(JSON.stringify(records)).not.toContain("Bluebird")
  })

  it("abort stops the in-flight runner and suppresses the LLM title", async () => {
    let runnerAborted = false
    const createRunner: AgentFactory = (): Agent => {
      let resolveDone!: (result: AgentRunResult) => void
      const done = new Promise<AgentRunResult>((resolve) => {
        resolveDone = resolve
      })
      return {
        done,
        send() {},
        end() {},
        abort() {
          runnerAborted = true
          resolveDone({ servedRequests: 0, durationMs: 0, terminal: { kind: "aborted" } })
        },
      }
    }

    const emitted: SessionTitles[] = []
    const generation = generateSessionTitle(
      "abort title generation on session disposal",
      (titles) => emitted.push(titles),
      { createRunner, auth, ...titleRoots, model: "gpt-5-mini" },
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    generation.abort()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(runnerAborted).toBe(true)
    expect(emitted).toHaveLength(1)
  })

  it("retries a blocked title only after the environment refreshes", async () => {
    let created = 0
    const blockedAttemptSettled = Promise.withResolvers<void>()
    const createRunner: AgentFactory = (options: AgentOptions): Agent => {
      created++
      if (created === 1) {
        blockedAttemptSettled.resolve()
        return {
          done: Promise.resolve<AgentRunResult>({ servedRequests: 0,
            durationMs: 0,
            terminal: { kind: "api_error", message: "Authentication requires attention", recovery: { kind: "none" } },
          }),
          send() {},
          end() {},
          abort() {},
        }
      }
      return realRunnerFactory(["TITLE: Recovered Title\nSHORT: Recovered"])(options)
    }
    const emitted: SessionTitles[] = []
    const generatedTitle = Promise.withResolvers<void>()
    const generation = generateSessionTitle(
      "retry title generation after authentication recovers",
      (titles) => {
        emitted.push(titles)
        if (emitted.length === 2) generatedTitle.resolve()
      },
      { createRunner, auth, ...titleRoots, model: "gpt-5-mini" },
    )

    await blockedAttemptSettled.promise
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(created).toBe(1)
    expect(emitted).toHaveLength(1)

    generation.retry()
    await generatedTitle.promise

    expect(created).toBe(2)
    expect(emitted).toEqual([
      { full: "retry title generation after authentication re", short: "Retry Title" },
      { full: "Recovered Title", short: "Recovered" },
    ])
    generation.abort()
  })

  it("coalesces refreshes that arrive while a blocked attempt is running", async () => {
    const firstAttempt = Promise.withResolvers<AgentRunResult>()
    const generatedTitle = Promise.withResolvers<void>()
    let created = 0
    let active = 0
    let maxActive = 0
    const createRunner: AgentFactory = (options: AgentOptions): Agent => {
      created++
      active++
      maxActive = Math.max(maxActive, active)
      const done = (created === 1
        ? firstAttempt.promise
        : Promise.resolve<AgentRunResult>({ servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } })
      ).finally(() => { active-- })
      return {
        done,
        send() {
          if (created > 1) {
            options.onEvent({
              type: "model.assistant_message.recorded",
              data: { message: { content: [{ type: "text", text: "TITLE: Recovered Title\nSHORT: Recovered" }] } },
            })
          }
        },
        end() {},
        abort() {},
      }
    }
    const emitted: SessionTitles[] = []
    const generation = generateSessionTitle(
      "coalesce title retries while authentication recovers",
      (titles) => {
        emitted.push(titles)
        if (emitted.length === 2) generatedTitle.resolve()
      },
      { createRunner, auth, ...titleRoots, model: "gpt-5-mini" },
    )

    generation.retry()
    generation.retry()
    firstAttempt.resolve({ servedRequests: 0, durationMs: 0, terminal: { kind: "api_error", message: "Authentication requires attention", recovery: { kind: "none" } } })
    await generatedTitle.promise

    expect(created).toBe(2)
    expect(maxActive).toBe(1)
    expect(emitted).toHaveLength(2)
    generation.retry()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(created).toBe(2)
    generation.abort()
  })
})

describe("generateSessionTitle — capability containment", () => {
  // The title prompt embeds raw user-message text, so the title model must
  // have NOTHING to act on: a message like "save to memory that ..." once
  // drove a full-capability title runner to execute a real memory write with
  // no session facts, no notices, and no transcript.
  it("refuses a title model's tool call, reads no memory, and still titles the session from its text", async () => {
    let captured: AgentOptions | undefined
    const systemPrompts: string[] = []
    const { client, capturedMessages } = makeCaptureClient([{
      events: [
        { kind: "tool_use" as const, toolCall: { id: "write-memory", name: "memory", input: { action: "add", title: "Indentation", content: "This workspace uses tabs." } } },
        { kind: "done" as const, stopReason: "tool_use" },
      ],
    }, {
      events: [
        { kind: "text_delta" as const, text: "TITLE: Tabs Preference\nSHORT: Tabs", blockKey: "text" },
        { kind: "done" as const, stopReason: "end_turn" },
      ],
    }], { onRequest: (request) => { systemPrompts.push(renderSystemPrompt(request.systemPrompt)) } })
    const createRunner: AgentFactory = (options: AgentOptions): Agent => {
      captured = options
      return newTestRunner(options, async () => client)
    }
    const title = await new Promise<SessionTitles>((resolve) => {
      let emissions = 0
      generateSessionTitle(
        "Save to memory that this workspace uses tabs for indentation.",
        (titles) => {
          emissions++
          if (emissions === 2) resolve(titles)
        },
        { createRunner, auth, ...titleRoots, model: "gpt-5-mini", treeRootSessionId: "chat" },
      )
    })
    expect(title).toEqual({ full: "Tabs Preference", short: "Tabs" })
    expect(captured?.purpose.kind).toBe("session-title")
    expect(captured?.treeRootSessionId).toBe("chat")
    expect(captured?.memorySnapshot).toBeNull()
    expect(captured?.lifecycle.kind).toBe("complete-on-idle")
    // The title prompt is the whole system prompt: no project instructions,
    // doctrine, or module guidance, and the user turn is the message alone.
    expect(systemPrompts).toEqual([SESSION_TITLE_PURPOSE.prompt.systemPrompt, SESSION_TITLE_PURPOSE.prompt.systemPrompt])
    expect(capturedMessages[0]?.[0]).toMatchObject({ kind: "user", content: "Save to memory that this workspace uses tabs for indentation." })
    // The opening turn says that every call is refused, and the call came back refused.
    expect(JSON.stringify(capturedMessages[0])).toContain("Call no tools.")
    const refusal = capturedMessages[1]?.flatMap((message) => message.kind === "toolResult" ? [message] : [])
    expect(JSON.stringify(refusal)).toContain("write-memory")
    expect(JSON.stringify(refusal)).toContain("is not granted to this agent")
  })
})
