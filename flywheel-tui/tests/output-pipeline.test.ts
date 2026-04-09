import { describe, it, expect, vi, afterEach } from "vitest"
import { createOutputPipeline, type OutputPipeline } from "../src/orchestration/output-pipeline"

describe("createOutputPipeline", () => {
  let pipeline: OutputPipeline | null = null

  afterEach(() => {
    pipeline?.dispose()
    pipeline = null
  })

  it("returns an object with parser, builder, eventParser, startFlush, dispose", () => {
    pipeline = createOutputPipeline()
    expect(pipeline.parser).toBeDefined()
    expect(pipeline.builder).toBeDefined()
    expect(pipeline.eventParser).toBeDefined()
    expect(typeof pipeline.startFlush).toBe("function")
    expect(typeof pipeline.dispose).toBe("function")
  })

  it("routes NDJSON events through eventParser to builder when wired by caller", () => {
    pipeline = createOutputPipeline()
    const { parser, builder, eventParser } = pipeline

    // Caller wires the onEvent handler (factory does NOT set it)
    parser.onEvent = (event) => {
      eventParser.dispatch(event, "claude")
    }

    // Feed a Claude-format assistant NDJSON event with a text block
    const ndjson = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Hello from pipeline test" },
        ],
      },
    })
    parser.write(ndjson + "\n")

    const blocks = builder.getBlocks()
    expect(blocks.length).toBeGreaterThan(0)
    const textBlock = blocks.find((b) => b.kind === "text")
    expect(textBlock).toBeDefined()
    expect((textBlock as { content: string }).content).toContain("Hello from pipeline test")
  })

  it("pushes raw text lines as text blocks via default onRawText", () => {
    pipeline = createOutputPipeline()
    const { parser, builder } = pipeline

    parser.write("plain text not json\n")

    const blocks = builder.getBlocks()
    expect(blocks.length).toBe(1)
    expect(blocks[0].kind).toBe("text")
    expect((blocks[0] as { content: string }).content).toContain("plain text not json")
  })

  it("fires onModelActivityChange callback", () => {
    const activityChanges: string[] = []
    pipeline = createOutputPipeline({
      onModelActivityChange: (activity) => activityChanges.push(activity),
    })
    const { parser, eventParser } = pipeline

    parser.onEvent = (event) => {
      eventParser.dispatch(event, "claude")
    }

    // Feed an assistant event with a text block (triggers "generating")
    const ndjson = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "some text" }],
      },
    })
    parser.write(ndjson + "\n")

    expect(activityChanges).toContain("generating")
  })

  it("dispose() cancels flush interval", async () => {
    pipeline = createOutputPipeline()
    const flushSpy = vi.fn()

    pipeline.startFlush(flushSpy, 10)

    // Trigger a change so builder.hasChanged() returns true
    pipeline.builder.pushText("test", Date.now())
    // Consume the change
    pipeline.builder.getBlocks()

    // Dispose should cancel the interval
    pipeline.dispose()
    pipeline = null // already disposed

    // Push another change — the flush callback should NOT fire after dispose
    // (We can't push to a disposed builder, so just wait and verify the spy wasn't called after dispose)
    flushSpy.mockClear()

    await new Promise((r) => setTimeout(r, 50))
    expect(flushSpy).not.toHaveBeenCalled()
  })

  it("startFlush fires onFlush when builder has changes", async () => {
    pipeline = createOutputPipeline()
    const flushSpy = vi.fn()

    pipeline.startFlush(flushSpy, 10)
    pipeline.builder.pushText("test", Date.now())

    await new Promise((r) => setTimeout(r, 50))
    expect(flushSpy).toHaveBeenCalled()
  })

  it("startFlush called twice cancels the first interval", async () => {
    pipeline = createOutputPipeline()
    const firstSpy = vi.fn()
    const secondSpy = vi.fn()

    pipeline.startFlush(firstSpy, 10)
    pipeline.startFlush(secondSpy, 10)

    // Push a change so hasChanged() is true
    pipeline.builder.pushText("test", Date.now())

    await new Promise((r) => setTimeout(r, 50))
    // First spy should NOT have been called (its interval was cancelled)
    expect(firstSpy).not.toHaveBeenCalled()
    // Second spy should have been called
    expect(secondSpy).toHaveBeenCalled()
  })
})
