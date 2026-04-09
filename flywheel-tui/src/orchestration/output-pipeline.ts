/**
 * Output Pipeline Factory
 *
 * Shared pipeline: NDJSONParser -> StructuredEventParser -> StructuredOutputBuilder.
 * Callers wire their own parser.onEvent handler for custom event processing.
 * Use eventParser.dispatch(event, engineId) inside your handler.
 */

import { NDJSONParser } from "./engines/subprocess/ndjson-parser"
import { StructuredOutputBuilder } from "../infra/output/structured-output-builder"
import { StructuredEventParser } from "../infra/output/structured-event-parser"
import type { ModelActivity } from "../infra/events"

export interface OutputPipeline {
  /** Feed raw stdout chunks from the subprocess. */
  readonly parser: NDJSONParser
  /** The structured block builder. Read blocks via builder.getBlocks(). */
  readonly builder: StructuredOutputBuilder
  /** The event parser. Call eventParser.dispatch(event, engineId) in your onEvent handler. */
  readonly eventParser: StructuredEventParser
  /** Start periodic flush. Returns cleanup function. */
  startFlush(onFlush: () => void, intervalMs?: number): () => void
  /** Dispose all resources (cancels active flush intervals). */
  dispose(): void
}

export interface OutputPipelineOptions {
  /** Called when model activity changes (thinking -> generating -> idle). */
  onModelActivityChange?: (activity: ModelActivity) => void
}

export function createOutputPipeline(opts?: OutputPipelineOptions): OutputPipeline {
  const builder = new StructuredOutputBuilder()
  const eventParser = new StructuredEventParser({ builder })
  const parser = new NDJSONParser()
  let activeFlushCleanup: (() => void) | null = null

  if (opts?.onModelActivityChange) {
    builder.onModelActivityChange = opts.onModelActivityChange
  }

  // Callers wire parser.onEvent themselves.
  // Default: just push raw text lines as text blocks.
  parser.onRawText = (text) => {
    if (text.trim().length > 0) builder.pushText(text + "\n", Date.now())
  }

  function startFlush(onFlush: () => void, intervalMs = 16): () => void {
    // Cancel previous interval if startFlush is called twice
    activeFlushCleanup?.()
    const id = setInterval(() => {
      if (builder.hasChanged()) onFlush()
    }, intervalMs)
    const cleanup = () => clearInterval(id)
    activeFlushCleanup = cleanup
    return cleanup
  }

  function dispose(): void {
    activeFlushCleanup?.()
    activeFlushCleanup = null
    builder.dispose()
  }

  return { parser, builder, eventParser, startFlush, dispose }
}
