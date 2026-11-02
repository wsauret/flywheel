import { releaseMeasurementNow } from "../../../src/infra/startup-trace.js"
import { withTimeout } from "../lib/isolated-serve.js"

export const WORKFLOW_LOAD_MODEL = "workflow-load-model"
export const WORKFLOW_LOAD_LAUNCH = "Launch active-load.workflow.yaml and wait for the workflow result."
export const WORKFLOW_LOAD_COMPETITOR = "Answer the competing chat in one sentence."
export const WORKFLOW_LOAD_KEYS = Array.from({ length: 50 }, (_, index) => `m14-${String(index + 1).padStart(2, "0")}`)

interface LoadDelta {
  readonly content?: string
  readonly tool_calls?: readonly { readonly index: number; readonly id?: string; readonly type?: string; readonly function: { readonly name?: string; readonly arguments: string } }[]
}

/** Controlled real streams. Each first request calls a gated command.
 * After all fifty commands are visible, every next request streams until it is released or settlement. */
export function startWorkflowLoadProvider() {
  const streamCadenceMs = 500
  const firstRequests = new Map<string, number>()
  const toolEdges = new Map<string, number>()
  const stages = new Map<string, number>()
  const serving = new Set<string>()
  const released = new Set<string>()
  const order: { key: string; at: number; stage: number }[] = []
  const requestEvidence: { model?: string; tools: string[]; messages: number; key?: string }[] = []
  let releaseCommands!: () => void
  const commands = new Promise<void>((resolve) => { releaseCommands = resolve })
  let settle = false
  let stopped = false
  let requests = 0
  let completed = 0
  let maxConcurrent = 0
  let concurrent = 0
  let competitorAt: number | undefined
  let parentAcknowledged = false
  const encoder = new TextEncoder()
  const chunk = (delta: LoadDelta, finishReason: string | null = null) => encoder.encode(`data: ${JSON.stringify({
    id: "workflow-load", object: "chat.completion.chunk", model: WORKFLOW_LOAD_MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`)
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path.endsWith("/models")) return Response.json({ data: [{ id: WORKFLOW_LOAD_MODEL, object: "model", created: 0, owned_by: "fixture" }] })
      if (path.startsWith("/gate/")) {
        await commands
        return new Response("command settled")
      }
      const body: { model?: string; tools?: { function?: { name?: string } }[]; messages?: { role?: string; content?: unknown }[] } = await request.json()
      const messages = body.messages ?? []
      const userText = messages.filter((message) => message.role === "user").map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n")
      const tools = body.tools?.flatMap((tool) => tool.function?.name ? [tool.function.name] : []) ?? []
      const key = tools.includes("handoff") ? /## Item\s+"(m14-\d+)"/u.exec(userText)?.[1] : undefined
      const launch = tools.includes("workflow") && !key && userText.includes(WORKFLOW_LOAD_LAUNCH)
      const competitor = tools.includes("workflow") && !key && userText.includes(WORKFLOW_LOAD_COMPETITOR)
      requestEvidence.push({ model: body.model, tools, messages: messages.length, key })
      const hasTool = messages.some((message) => message.role === "tool")
      if (launch && hasTool) parentAcknowledged = true
      const stage = key ? (stages.get(key) ?? 0) + 1 : 0
      const now = releaseMeasurementNow()
      requests++
      if (key) {
        stages.set(key, stage)
        if (!firstRequests.has(key)) firstRequests.set(key, now)
        order.push({ key, stage, at: now })
      }
      if (competitor) { competitorAt ??= now; order.push({ key: "chat", stage: 0, at: now }) }
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      let canceled = false
      return new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (value: Uint8Array) => { if (!canceled && !stopped) controller.enqueue(value) }
          try {
            let call: { id: string; name: string; arguments: string } | undefined
            if (launch && !hasTool) {
              call = { id: "m14-launch", name: "workflow", arguments: JSON.stringify({
                summary: "Fifty active agents", source: { kind: "path", path: "active-load.workflow.yaml" },
                description: "Run the controlled active workload for each item.", input: { keys: WORKFLOW_LOAD_KEYS },
              }) }
            } else if (key && stage === 1) {
              await Bun.sleep(200)
              const command = `echo ${key}; bun -e 'console.log(await (await fetch("http://127.0.0.1:${server.port}/gate/${key}")).text())'`
              call = { id: `edge-${key}`, name: "bash", arguments: JSON.stringify({ command }) }
              toolEdges.set(key, releaseMeasurementNow())
            } else if (key) {
              serving.add(key)
              const streaming = () => !settle && !released.has(key) && !stopped && !canceled
              while (streaming()) {
                send(chunk({ content: "The active workload streams bounded text. " }))
                await Bun.sleep(streamCadenceMs)
              }
              serving.delete(key)
              call = { id: `handoff-${key}`, name: "handoff", arguments: JSON.stringify({ summary: `Completed ${key}.` }) }
            }
            if (call) {
              send(chunk({ tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: "" } }] }))
              // Arguments arrive separately, so the edge begins at the provider, not at the decoded tool.
              for (let offset = 0; offset < call.arguments.length; offset += 32) {
                send(chunk({ tool_calls: [{ index: 0, function: { arguments: call.arguments.slice(offset, offset + 32) } }] }))
                await Bun.sleep(5)
              }
            } else send(chunk({ content: "The controlled request completed." }))
            send(chunk({}, call ? "tool_calls" : "stop"))
            send(encoder.encode(`data: ${JSON.stringify({ id: "workflow-load", object: "chat.completion.chunk", model: WORKFLOW_LOAD_MODEL, choices: [], usage: { prompt_tokens: 400, completion_tokens: 100, total_tokens: 500 } })}\n\ndata: [DONE]\n\n`))
            if (!canceled) completed++
          } finally {
            concurrent--
            if (!canceled) controller.close()
          }
        },
        cancel() { canceled = true },
      }), { headers: { "content-type": "text/event-stream" } })
    },
  })
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    firstRequests, toolEdges, order, serving, requestEvidence, streamCadenceMs,
    counts: () => ({ requests, completed, maxConcurrent, concurrent, competitorAt, parentAcknowledged }),
    releaseCommands,
    releaseOne() {
      const key = [...serving].find((value) => !released.has(value))
      if (!key) throw new Error("no serving agent can end its stream")
      released.add(key)
    },
    settle() { settle = true; releaseCommands() },
    async stop() {
      stopped = true
      releaseCommands()
      await withTimeout("loopback stream drain", server.stop(true), 10_000)
    },
  }
}
