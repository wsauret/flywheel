/**
 * Tests for session title generation.
 *
 * Tests the synchronous fallback behavior of generateSessionTitle —
 * the immediate callback fires with first-5-words before the async LLM call.
 * The LLM call itself isn't tested here (requires subprocess).
 */

import { describe, it, expect } from "bun:test"
import type { Engine, EngineResult, RunnerOptions } from "../src/orchestration/engines/core/types.js"
import { resolveModelForTier } from "../src/orchestration/config/model-tiers.js"
import { generateSessionTitle } from "../src/orchestration/session-title.js"

const OPENAI_CHEAP = resolveModelForTier("cheap", "openai")
const ANTHROPIC_CHEAP = resolveModelForTier("cheap", "anthropic")

describe("generateSessionTitle — immediate fallback", () => {
  it("calls onTitle immediately with a short message as-is", () => {
    const titles: string[] = []
    generateSessionTitle("fix bug", (t) => titles.push(t))
    // Synchronous callback should have fired
    expect(titles.length).toBeGreaterThanOrEqual(1)
    expect(titles[0]).toBe("fix bug")
  })

  it("truncates to first 5 words", () => {
    const titles: string[] = []
    generateSessionTitle("What is the meaning of life and everything", (t) => titles.push(t))
    expect(titles[0]).toBe("What is the meaning of...")
  })

  it("adds ellipsis when word count exceeds 5", () => {
    const titles: string[] = []
    generateSessionTitle("one two three four five six", (t) => titles.push(t))
    expect(titles[0]).toBe("one two three four five...")
  })

  it("no ellipsis when exactly 5 words", () => {
    const titles: string[] = []
    generateSessionTitle("one two three four five", (t) => titles.push(t))
    expect(titles[0]).toBe("one two three four five")
  })

  it("truncates long words to 40 chars", () => {
    const titles: string[] = []
    generateSessionTitle("superlongword anotherlongword yetanotherlongword etc morestuff", (t) => titles.push(t))
    expect(titles[0].length).toBeLessThanOrEqual(40)
    expect(titles[0]).toEndWith("...")
  })

  it("trims whitespace", () => {
    const titles: string[] = []
    generateSessionTitle("  hello world  ", (t) => titles.push(t))
    expect(titles[0]).toBe("hello world")
  })

  it("single word returned as-is", () => {
    const titles: string[] = []
    generateSessionTitle("refactor", (t) => titles.push(t))
    expect(titles[0]).toBe("refactor")
  })
})

describe("generateSessionTitle — LLM model selection", () => {
  function makeSpyEngine(): { engine: Engine; receivedModels: string[] } {
    const receivedModels: string[] = []
    const engine: Engine = {
      metadata: {
        id: "harness",
        name: "Harness",
        defaultModel: "claude-opus-4-7",
        description: "test harness",
      },
      createRunner(options: RunnerOptions) {
        receivedModels.push(options.model)
        const assistantEvent = {
          type: "assistant",
          data: {
            message: {
              content: [{ type: "text", text: "Generated Title" }],
            },
          },
        } as Parameters<RunnerOptions["onEvent"]>[0]
        const done = Promise.resolve<EngineResult>({ durationMs: 0 })
        return {
          done,
          send() {
            options.onEvent(assistantEvent)
          },
          end() {},
          abort() {},
        }
      },
    }
    return { engine, receivedModels }
  }

  async function allowLlmTitleGeneration(run: () => Promise<void>): Promise<void> {
    const prevNodeEnv = process.env.NODE_ENV
    const prevBunEnv = process.env.BUN_ENV
    try {
      process.env.NODE_ENV = "development"
      delete process.env.BUN_ENV
      await run()
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = prevNodeEnv
      if (prevBunEnv === undefined) delete process.env.BUN_ENV
      else process.env.BUN_ENV = prevBunEnv
    }
  }

  it("uses the OpenAI cheap tier for harness OpenAI sessions", async () => {
    const { engine, receivedModels } = makeSpyEngine()
    const titles: string[] = []

    await allowLlmTitleGeneration(async () => {
      generateSessionTitle(
        "fix title generation for openai sessions",
        (title) => titles.push(title),
        { engine, projectCwd: "/tmp", model: "gpt-5.3-codex" },
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(receivedModels).toEqual([OPENAI_CHEAP])
    expect(titles.at(-1)).toBe("Generated Title")
  })

  it("uses the Anthropic cheap tier for harness Anthropic sessions", async () => {
    const { engine, receivedModels } = makeSpyEngine()
    const titles: string[] = []

    await allowLlmTitleGeneration(async () => {
      generateSessionTitle(
        "fix title generation for anthropic sessions",
        (title) => titles.push(title),
        { engine, projectCwd: "/tmp", model: "claude-opus-4-7" },
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(receivedModels).toEqual([ANTHROPIC_CHEAP])
    expect(titles.at(-1)).toBe("Generated Title")
  })

  it("falls back to the current model when the cheap title model fails", async () => {
    const receivedModels: string[] = []
    const engine: Engine = {
      metadata: {
        id: "harness",
        name: "Harness",
        defaultModel: "claude-opus-4-7",
        description: "test harness",
      },
      createRunner(options: RunnerOptions) {
        receivedModels.push(options.model)
        if (options.model === OPENAI_CHEAP) {
          return {
            done: Promise.resolve<EngineResult>({
              durationMs: 0,
              failure: { kind: "api_error", message: "no access" },
            }),
            send() {},
            end() {},
            abort() {},
          }
        }
        const assistantEvent = {
          type: "assistant",
          data: {
            message: {
              content: [{ type: "text", text: "Recovered Title" }],
            },
          },
        } as Parameters<RunnerOptions["onEvent"]>[0]
        return {
          done: Promise.resolve<EngineResult>({ durationMs: 0 }),
          send() {
            options.onEvent(assistantEvent)
          },
          end() {},
          abort() {},
        }
      },
    }
    const titles: string[] = []

    await allowLlmTitleGeneration(async () => {
      generateSessionTitle(
        "fall back when the cheap title model is unavailable",
        (title) => titles.push(title),
        { engine, projectCwd: "/tmp", model: "gpt-4o-mini" },
      )
      await Promise.resolve()
      await Promise.resolve()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })

    expect(receivedModels).toEqual([OPENAI_CHEAP, "gpt-4o-mini"])
    expect(titles.at(-1)).toBe("Recovered Title")
  })
})
