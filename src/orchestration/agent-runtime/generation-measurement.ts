import { commonLocalTokenizer, prepareLocalTokenizer, type LocalTokenizer } from "../../infra/local-tokenizer.js"
import type { GenerationMeasurement } from "../session/provider-request-audit-types.js"
import type { ProviderStreamEvent } from "./llm/types.js"

export interface GenerationMeasurementTokenizer {
  prepare(): Promise<void>
  tokenizer(): LocalTokenizer
}

/** The settled text of the response's text block that streamed under a block key, or undefined when the response
 *  holds no such block. */
export type SettledTextOf = (blockKey: string) => string | undefined

interface OutputTiming {
  chunkCount: number
  first?: number
  last?: number
}

interface ToolInputOutput extends OutputTiming {
  chunks: string[]
}

/** Times the original output of one request at monotonic observation times. A text block keeps only its timing, and
 *  completion counts its settled text from `textOf`, which the turn result holds. A tool input keeps its original
 *  chunks, because the provider's generated text exists nowhere else. Completion releases all content. Preparation
 *  rejection yields unavailable; counting errors reject. */
export function createGenerationMeasurement(deps: GenerationMeasurementTokenizer = {
  prepare: prepareLocalTokenizer,
  tokenizer: commonLocalTokenizer,
}) {
  const texts = new Map<string, OutputTiming>()
  const tools = new Map<string, ToolInputOutput>()
  const textTiming = (blockKey: string): OutputTiming => {
    let output = texts.get(blockKey)
    if (!output) {
      output = { chunkCount: 0 }
      texts.set(blockKey, output)
    }
    return output
  }
  const toolInput = (toolUseId: string): ToolInputOutput => {
    let output = tools.get(toolUseId)
    if (!output) {
      output = { chunkCount: 0, chunks: [] }
      tools.set(toolUseId, output)
    }
    return output
  }
  const time = (output: OutputTiming, first: number, last = first, chunks = 1): void => {
    output.chunkCount += chunks
    output.first ??= first
    output.last = last
  }
  return {
    observe(event: ProviderStreamEvent, at: number): void {
      switch (event.kind) {
        case "text_delta":
          if (event.text) time(textTiming(event.blockKey), at)
          break
        case "tool_input_delta": {
          const text = event.generationText ?? event.partialJson
          if (!text) break
          const output = toolInput(event.toolUseId)
          output.chunks.push(text)
          time(output, event.generationTiming?.first ?? at, event.generationTiming?.last ?? at, event.generationTiming?.chunks ?? 1)
          break
        }
        case "text_terminal":
          if (event.content) textTiming(event.blockKey)
          break
        case "tool_use": toolInput(event.toolCall.id); break
      }
    },
    async complete(textOf: SettledTextOf): Promise<GenerationMeasurement> {
      try {
        const eligible: { text: string; first: number; last: number }[] = []
        const measure = (output: OutputTiming, text: () => string | undefined): void => {
          if (output.chunkCount < 2 || output.first === undefined || output.last === undefined || output.last <= output.first) return
          const measured = text()
          if (measured !== undefined) eligible.push({ text: measured, first: output.first, last: output.last })
        }
        for (const [blockKey, output] of texts) measure(output, () => textOf(blockKey))
        for (const output of tools.values()) measure(output, () => output.chunks.join(""))
        const excludedBlocks = texts.size + tools.size - eligible.length
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
        texts.clear()
        tools.clear()
      }
    },
  }
}
