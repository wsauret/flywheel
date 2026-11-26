import { describe, expect, test } from "bun:test"
import {
  commonLocalTokenizer,
  localTokenizerForModel,
  prepareLocalTokenizer,
  type LocalTokenizerIdentity,
} from "../../../../src/infra/providers/local-tokenizer.js"
import type { ClaudeTokenizerIdentity } from "../../../../src/infra/providers/model-id.js"

describe("local tokenizer", () => {
  test("does not load or count a mapped model before preparation", async () => {
    expect(localTokenizerForModel("arbitrary-model")?.count("secret prompt")).toBeUndefined()
    expect(() => localTokenizerForModel("gpt-4o")?.count("secret prompt")).toThrow("Local tokenizer is not prepared")
    expect(() => commonLocalTokenizer()).toThrow("Local tokenizer is not prepared")

    await Promise.all([prepareLocalTokenizer(), prepareLocalTokenizer()])
  })

  test("maps approved canonical model identities to their native encodings", async () => {
    await prepareLocalTokenizer()

    const mappings: ReadonlyArray<readonly [string, LocalTokenizerIdentity, number]> = [
      ["gpt-4o", "O200kBase", 4],
      ["gpt-4o-mini", "O200kBase", 4],
      ["gpt-4.1", "O200kBase", 4],
      ["gpt-4.1-2025-04-14", "O200kBase", 4],
      ["gpt-4.5-preview", "O200kBase", 4],
      ["o1", "O200kBase", 4],
      ["o1-pro", "O200kBase", 4],
      ["o3", "O200kBase", 4],
      ["o4-mini", "O200kBase", 4],
      ["gpt-5", "O200kBase", 4],
      ["gpt-5-chat-latest", "O200kBase", 4],
      ["gpt-5.1-chat-latest", "O200kBase", 4],
      ["gpt-5.2-chat-latest", "O200kBase", 4],
      ["gpt-5.3-chat-latest", "O200kBase", 4],
      ["gpt-6-luna", "O200kBase", 4],
      ["gpt-6.1-sol", "O200kBase", 4],
      ["gpt-6-astra", "O200kBase", 4],
      ["gpt-6-luna-2026-07-09", "O200kBase", 4],
    ]
    for (const [model, identity, count] of mappings) {
      expect(localTokenizerForModel(model)?.identity, model).toBe(identity)
      expect(localTokenizerForModel(model)?.count("Hello, world!"), model).toBe(count)
    }

    const catalogMappings: ReadonlyArray<readonly [ClaudeTokenizerIdentity, LocalTokenizerIdentity, number]> = [
      ["ClaudeV3", "ClaudeV3", 4],
      ["ClaudeV47", "ClaudeV47", 6],
      ["ClaudeV5", "ClaudeV5", 6],
      ["ClaudeV5Sonnet", "ClaudeV5Sonnet", 6],
    ]
    for (const [catalogIdentity, identity, count] of catalogMappings) {
      expect(localTokenizerForModel("catalog-resolved-claude", catalogIdentity)?.identity).toBe(identity)
      expect(localTokenizerForModel("catalog-resolved-claude", catalogIdentity)?.count("Hello, world!")).toBe(count)
    }

    const retiredGeneration = [5, 6].join(".")
    for (const model of [
      "GPT-4o",
      "openai/gpt-4o",
      "gpt-5-codex",
      `gpt-${retiredGeneration}`,
      `gpt-${retiredGeneration}-luna`,
      "o5",
      "claude-haiku-5",
      "claude-opus-5.1",
      "claude-sonnet-6",
      "claude-opus-4.7",
      "claude-fable-5",
      "arbitrary-model",
    ]) {
      expect(localTokenizerForModel(model)?.count("hello world"), model).toBeUndefined()
    }
  })

  test("preserves UTF-16 input semantics across repeated calls", async () => {
    await prepareLocalTokenizer()
    const text = "A\ud800B\udc00C"

    expect(localTokenizerForModel("gpt-4o")?.count(text)).toBe(localTokenizerForModel("gpt-4o")?.count(text))
  })

  test("counts common Unicode comparison units without an approved model mapping", async () => {
    await prepareLocalTokenizer()
    const tokenizer = commonLocalTokenizer()
    const text = 'Hello 🌍. {"path":"a.txt","value":42}'
    expect(tokenizer.identity).toBe("O200kBase")
    expect(tokenizer.count(text)).toBe(14)
    expect(localTokenizerForModel("unmapped-model")).toBeUndefined()
  })
})
