const MODEL = "scroll-fixture"
const TITLE_MODEL = "scroll-title"
export const SCROLL_GROWTH_PROMPT = "SCROLL-GROWTH: stream the transcript fixture"

/** A loopback provider keeps the ordinary reply pipeline growing until the measured scroll ends. No external calls occur. */
export function startScrollGrowthProvider() {
  let stopped = false
  let deltas = 0
  let started = false
  const tasks: Promise<void>[] = []
  const encoder = new TextEncoder()
  const chunk = (model: string, content: string, finish: string | null = null) => `data: ${JSON.stringify({
    id: "scroll-growth", object: "chat.completion.chunk", model,
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
  })}\n\n`
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/models")) return Response.json({
        data: [MODEL, TITLE_MODEL].map(id => ({ id, object: "model", created: 0, owned_by: "fixture" })),
      })
      const body: { model: string; messages: unknown[] } = await request.json()
      const growing = body.model === MODEL && JSON.stringify(body.messages).includes(SCROLL_GROWTH_PROMPT)
      let canceled = false
      // stop() and cancel() end the stream between awaits, which a loop condition on the bare flags would hide.
      const streaming = () => !stopped && !canceled
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const task = (async () => {
            if (growing) {
              started = true
              while (streaming()) {
                controller.enqueue(encoder.encode(chunk(body.model, `\n\n### Growing turn ${deltas}\nThe transcript adds **styled text**, a list, and \`inline code\`.\n\n- Scroll while this reply grows.\n`)))
                deltas++
                await Bun.sleep(20)
              }
            } else controller.enqueue(encoder.encode(chunk(body.model, "Scroll fixture")))
            if (!canceled) {
              controller.enqueue(encoder.encode(chunk(body.model, "", "stop") + "data: [DONE]\n\n"))
              controller.close()
            }
          })()
          tasks.push(task)
        },
        cancel() { canceled = true },
      }), { headers: { "content-type": "text/event-stream" } })
    },
  })
  return {
    config: { baseUrl: `http://127.0.0.1:${server.port}/v1`, models: [MODEL, TITLE_MODEL] as const, contextLimit: 2_000_000,
      roleModels: { "title-generation": TITLE_MODEL, "learning-review": TITLE_MODEL } },
    get started() { return started },
    get deltas() { return deltas },
    async stop() {
      stopped = true
      await Promise.all(tasks)
      await server.stop(true)
    },
  }
}
