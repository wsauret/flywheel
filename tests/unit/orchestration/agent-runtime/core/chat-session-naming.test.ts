/**
 * Tests for session title generation.
 *
 * `generateSessionTitle` fires `onTitle` synchronously with a deterministic
 * quick title (first-10 words full label, first-2 short label, hard-truncated
 * with no ellipsis), then again with the LLM title when generation succeeds.
 * Without a `model` in deps the LLM path returns null before touching the
 * runner, so the first emission is the only one — the quick-title tests rely
 * on that. The LLM path uses the model, effort, and provider options supplied
 * by the captured title-generation role. Retry/truncation/abort resilience lives in
 * session-title-resilience.test.ts.
 */

import { describe, it, expect } from "bun:test"
import type { AgentRunResult, Agent, AgentFactory, AgentOptions } from "../../../../../src/orchestration/agent-runtime/types.js"
import { newTestRunner } from "../../../../helpers/agent-runner.js"
import {
  forkSessionTitles,
  generateSessionTitle,
  type SessionTitles,
} from "../../../../../src/orchestration/session/session-title.js"
import { titlesFromName } from "../../../../../src/orchestration/session/session-label.js"
import { makeCaptureClient } from "../context/_loop-fixtures.js"
import { testAuth as auth, titleRoots } from "../../../../fixtures/session-title-fixtures.js"

describe("generateSessionTitle — immediate quick title", () => {
  function quickTitles(message: string): SessionTitles {
    const emitted: SessionTitles[] = []
    generateSessionTitle(message, (titles) => emitted.push(titles), {
      createRunner: () => {
        throw new Error("LLM path must not run without a model")
      },
      auth,
      ...titleRoots,
    })
    expect(emitted).toHaveLength(1)
    return emitted[0]!
  }

  it("title-cases the short label without changing the full label", () => {
    expect(quickTitles("fix API bug")).toEqual({ full: "fix API bug", short: "Fix API" })
  })

  it("truncates to first 10 words", () => {
    expect(quickTitles("Why is the sky blue and not green or red today too"))
      .toEqual({ full: "Why is the sky blue and not green or red", short: "Why Is" })
  })

  it("keeps all words when exactly 10 words", () => {
    expect(quickTitles("w1 w2 w3 w4 w5 w6 w7 w8 w9 w10"))
      .toEqual({ full: "w1 w2 w3 w4 w5 w6 w7 w8 w9 w10", short: "W1 W2" })
  })

  it("hard-truncates long words to compact limits without ellipsis", () => {
    const titles = quickTitles("superlongword anotherlongword yetanotherlongword etc morestuff")
    expect(titles.full.length).toBeLessThanOrEqual(46)
    expect(titles.short.length).toBeLessThanOrEqual(14)
    expect(titles.full).not.toEndWith("...")
    expect(titles.short).not.toEndWith("...")
  })

  it("trims whitespace", () => {
    expect(quickTitles("  hello world  "))
      .toEqual({ full: "hello world", short: "Hello World" })
  })

  it("single word returned as-is", () => {
    expect(quickTitles("refactor")).toEqual({ full: "refactor", short: "Refactor" })
  })
})

describe("forkSessionTitles", () => {
  it("uses a deterministic full title and a short title of whole words", () => {
    expect(forkSessionTitles({ label: "A long source session", shortLabel: "Compact source" })).toEqual({
      full: "Fork of A long source session",
      short: "Fork: Compact",
    })
    expect(forkSessionTitles({ label: "Fallback source" })).toEqual({
      full: "Fork of Fallback source",
      short: "Fork: Fallback",
    })
    expect(forkSessionTitles({ label: "Edit the files", shortLabel: "File Edits" }).short).toBe("Fork: File")
    // Only a first word longer than the room is cut.
    expect(forkSessionTitles({ label: "Investigation", shortLabel: "Investigation" }).short).toBe("Fork: Investig")
  })

  it("keeps a nested fork distinct from its source tab", () => {
    const source = { label: "Fork of Fork of Source", shortLabel: "Fork: Fork: Fo" }
    const fork = forkSessionTitles(source)

    expect(fork.short).toStartWith("Fork:")
    expect(fork.short).not.toBe(source.shortLabel)
  })
})

describe("titlesFromName — user-chosen session names", () => {
  it("keeps the full name verbatim and derives a tight tab label", () => {
    expect(titlesFromName("Investigate the flaky provider stream watchdog"))
      .toEqual({ full: "Investigate the flaky provider stream watchdog", short: "Investigate th" })
  })

  it("uses the first two words for the short label within the tab budget", () => {
    expect(titlesFromName("Parser bug hunt")).toEqual({ full: "Parser bug hunt", short: "Parser bug" })
  })

  it("single word is both labels", () => {
    expect(titlesFromName("refactor")).toEqual({ full: "refactor", short: "refactor" })
  })
})

describe("generateSessionTitle — LLM model selection", () => {
  function makeSpyRunnerFactory() {
    const receivedModels: Array<string | undefined> = []
    const receivedOptions: AgentOptions[] = []
    const createRunner: AgentFactory = (options: AgentOptions): Agent => {
      receivedModels.push(options.model)
      receivedOptions.push(options)
      const assistantEvent = {
        type: "model.assistant_message.recorded",
        data: {
          message: {
            content: [{ type: "text", text: "TITLE: Generated Title\nSHORT: Generated" }],
          },
        },
      } satisfies Parameters<AgentOptions["onEvent"]>[0]
      const done = Promise.resolve<AgentRunResult>({ servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } })
      return {
        done,
        send() {
          options.onEvent(assistantEvent)
        },
        end() {},
        abort() {},
      }
    }
    return { createRunner, receivedModels, receivedOptions }
  }

  it("uses only the captured title role assignment", async () => {
    const { createRunner, receivedModels, receivedOptions } = makeSpyRunnerFactory()
    const titles: SessionTitles[] = []

    generateSessionTitle(
      "fix title generation for expensive chat models",
      (title) => titles.push(title),
      { createRunner, auth, ...titleRoots, model: "deepseek-v4.1-flash", effort: "high", providerOptions: { openai: { service_tier: "priority" } } },
    )
    await Promise.resolve()
    await Promise.resolve()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(receivedModels).toEqual(["deepseek-v4.1-flash"])
    expect(receivedOptions[0]!.effort).toBe("high")
    expect(receivedOptions[0]!.providerOptions).toEqual({ openai: { service_tier: "priority" } })
    expect(titles.at(-1)).toEqual({ full: "Generated Title", short: "Generated" })
  })

  it("does not fall back after the assigned title model fails", async () => {
    const receivedOptions: AgentOptions[] = []
    const createRunner: AgentFactory = (options: AgentOptions): Agent => {
      receivedOptions.push(options)
      return {
        done: Promise.resolve<AgentRunResult>({ servedRequests: 0, durationMs: 0, terminal: { kind: "context_overflow" } }),
        send() {},
        end() {},
        abort() {},
      }
    }

    const titles: SessionTitles[] = []
    generateSessionTitle(
      "keep the quick title when the assigned model fails",
      (title) => titles.push(title),
      { createRunner, auth, ...titleRoots, model: "gpt-6-luna", effort: "low", providerOptions: { openai: { service_tier: "priority" } } },
    )
    await Promise.resolve()
    await Promise.resolve()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(receivedOptions.map((options) => options.model)).toEqual(["gpt-6-luna"])
    expect(titles).toHaveLength(1)
  })

  it("accepts a lazy deps resolver for first-message model changes", async () => {
    const { createRunner, receivedModels } = makeSpyRunnerFactory()
    const titles: SessionTitles[] = []

    generateSessionTitle(
      "use current model for delayed first message titles",
      (title) => titles.push(title),
      async () => ({ createRunner, auth, ...titleRoots, model: "gpt-5.5" }),
    )
    await Promise.resolve()
    await Promise.resolve()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(receivedModels).toEqual(["gpt-5.5"])
    expect(titles.at(-1)).toEqual({ full: "Generated Title", short: "Generated" })
  })


  it("completes through the real one-shot agent runner", async () => {
    const { client } = makeCaptureClient([
      { events: [
        { kind: "text_delta", text: "TITLE: Generated Title\nSHORT: Generated", blockKey: "text" },
        { kind: "done", stopReason: "end_turn" },
      ] },
    ])
    const createRunner: AgentFactory = (options: AgentOptions): Agent => newTestRunner(
      options,
      async () => client,
    )

    let title: SessionTitles | null = null
    title = await new Promise<SessionTitles>((resolve) => {
      let emissions = 0
      generateSessionTitle(
        "fix real title runner completion",
        (titles) => {
          // Quick title fires first, the generated LLM title second. Resolve on
          // the second emission -- a deterministic completion signal -- rather
          // than racing a fixed wall-clock timer (the old `setTimeout(..., 30)`
          // lost the race under parallel-shard load and resolved `null`). A
          // genuinely broken runner now surfaces as bun's per-test timeout.
          emissions++
          if (emissions === 2) resolve(titles)
        },
        { createRunner, auth, ...titleRoots, model: "gpt-5-mini" },
      )
    })

    expect(title).toEqual({ full: "Generated Title", short: "Generated" })
  })

  it("skips the LLM path entirely without a session model", async () => {
    const titles: SessionTitles[] = []

    generateSessionTitle(
      "no provider means no llm title",
      (title) => titles.push(title),
      {
        createRunner: () => {
          throw new Error("LLM path must not run without a model")
        },
        auth,
        ...titleRoots,
      },
    )
    await Promise.resolve()
    await Promise.resolve()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(titles).toHaveLength(1)
  })
})
