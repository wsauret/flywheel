import { commonLocalTokenizer, prepareLocalTokenizer, type LocalTokenizer } from "../../infra/local-tokenizer.js"
import type { GenerationMeasurement } from "../session/provider-request-audit-types.js"
import type { ProviderStreamEvent } from "./llm/types.js"

export interface GenerationMeasurementTokenizer {
  prepare(): Promise<void>
  tokenizer(): LocalTokenizer
}

interface OutputBlock {
  chunks: string[]
  chunkCount: number
  terminal?: string
  first?: number
  last?: number
}

/** Collects original output for one request at monotonic observation times. Completion counts assembled blocks and releases all content. Preparation rejection yields unavailable; counting errors reject. */
export function createGenerationMeasurement(deps: GenerationMeasurementTokenizer = {
  prepare: prepareLocalTokenizer,
  tokenizer: commonLocalTokenizer,
}) {
  const blocks = new Map<string, OutputBlock>()
  const block = (key: string): OutputBlock => {
    let output = blocks.get(key)
    if (!output) {
      output = { chunks: [], chunkCount: 0 }
      blocks.set(key, output)
    }
    return output
  }
  const append = (key: string, text: string, first: number, last = first, chunks = 1): void => {
    if (!text) return
    const output = block(key)
    output.chunks.push(text)
    output.chunkCount += chunks
    output.first ??= first
    output.last = last
  }
  return {
    observe(event: ProviderStreamEvent, at: number): void {
      switch (event.kind) {
        case "text_delta": append(`text:${event.blockKey}`, event.text, at); break
        case "tool_input_delta":
          append(`tool:${event.toolUseId}`, event.generationText ?? event.partialJson, event.generationTiming?.first ?? at, event.generationTiming?.last ?? at, event.generationTiming?.chunks ?? 1)
          break
        case "text_terminal":
          if (event.content || blocks.has(`text:${event.blockKey}`)) block(`text:${event.blockKey}`).terminal = event.content
          break
        case "tool_use": block(`tool:${event.toolCall.id}`); break
      }
    },
    async complete(): Promise<GenerationMeasurement> {
      try {
        const eligible: { text: string; first: number; last: number }[] = []
        for (const output of blocks.values()) {
          if (output.chunkCount >= 2 && output.first !== undefined && output.last !== undefined && output.last > output.first) {
            eligible.push({ text: output.terminal ?? output.chunks.join(""), first: output.first, last: output.last })
          }
        }
        const excludedBlocks = blocks.size - eligible.length
        if (!eligible.length) return { kind: "recorded", basis: "O200kBase", outputTokens: 0, durationMs: 0, measuredBlocks: 0, excludedBlocks }
        try {
          await deps.prepare()
        } catch {
          return { kind: "unavailable", reason: "tokenizer-preparation-failed" }
        }
        const tokenizer = deps.tokenizer()
        let outputTokens = 0
        for (const output of eligible) outputTokens += tokenizer.count(output.text)
        const intervals = eligible.map((output) => [output.first, output.last] as const).sort(([a], [b]) => a - b)
        let durationMs = 0
        let end = Number.NEGATIVE_INFINITY
        for (const [first, last] of intervals) {
          durationMs += Math.max(0, last - Math.max(first, end))
          end = Math.max(end, last)
        }
        return { kind: "recorded", basis: "O200kBase", outputTokens, durationMs, measuredBlocks: eligible.length, excludedBlocks }
      } finally {
        blocks.clear()
      }
    },
  }
}
