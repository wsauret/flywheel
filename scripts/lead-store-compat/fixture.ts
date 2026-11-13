import { Schema } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"

/** The shared harness of the two steps of `scripts/lead-store-compat.ts`: the
 *  fake model, the layout of the temporary project, and a project composition
 *  built from the code of one checkout. A step passes the root of its
 *  checkout, so the branch step runs the branch's code and the main step runs
 *  the main checkout's code on disk. The types name the branch's modules; the
 *  values come from `root`. */

export const FIXTURE_MODEL = "gpt-5"
/** The person's text that makes the fake model call `route_request` in the lead chat. */
export const ROUTE_MARK = "COMPAT-ROUTE"
/** The person's text of the turn that the main checkout runs in the started chat. */
export const MAIN_TURN_TEXT = "COMPAT-MAIN-TURN"

/** The message of the one warning that each step writes through the log of its checkout. */
export const LOG_MARKER = "lead-store-compat log marker"

/** The fake model's final text for a turn whose newest person message starts with `text`. */
export const replyTo = (text: string): string => `COMPAT-REPLY ${text}`

/** The directories of the temporary project. Every step derives them from the one temporary root. */
export function layout(root: string) {
  const accountHome = path.join(root, "home")
  return {
    root,
    project: path.join(root, "project"),
    accountHome,
    userDataRoot: path.join(accountHome, ".flywheel"),
    logBase: path.join(root, "logs"),
    ids: path.join(root, "ids.json"),
  }
}

const StartedIdsSchema = Schema.Struct({ leadSessionId: Schema.String, startedSessionId: Schema.String })
export type StartedIds = typeof StartedIdsSchema.Type

export const readIds = (root: string): StartedIds => Schema.decodeUnknownSync(StartedIdsSchema)(JSON.parse(fs.readFileSync(layout(root).ids, "utf8")))

const sse = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((part: unknown) => typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "").join("\n")
}

const MessageSchema = Schema.Struct({ role: Schema.optionalKey(Schema.String), kind: Schema.optionalKey(Schema.String), content: Schema.optionalKey(Schema.Unknown) })
const ChatRequestSchema = Schema.Struct({
  messages: Schema.optionalKey(Schema.Array(MessageSchema)),
  tools: Schema.optionalKey(Schema.Array(Schema.Struct({ function: Schema.optionalKey(Schema.Struct({ name: Schema.optionalKey(Schema.String) })) }))),
})
const SessionCreatedSchema = Schema.Struct({ conversationId: Schema.optionalKey(Schema.String) })
const EntriesAppendedSchema = Schema.Struct({ entries: Schema.Array(Schema.Struct({ kind: Schema.String, message: Schema.optionalKey(MessageSchema) })) })

type Delta = { readonly content: string } | { readonly tool_calls: readonly { readonly index: number; readonly id: string; readonly type: "function"; readonly function: { readonly name: string; readonly arguments: string } }[] }

/** A loopback chat-completions provider. A request with no tools is a title request. In a chat whose tools hold
 *  `route_request`, a person message that holds `ROUTE_MARK` gets one `route_request { kind: "new" }` call; every
 *  other turn ends with `replyTo` of the newest person text. */
export function startFakeModel() {
  let calls = 0
  const tag = crypto.randomUUID().slice(0, 8)
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: FIXTURE_MODEL, object: "model", created: 0, owned_by: "fixture" }] })
      const body = Schema.decodeUnknownSync(ChatRequestSchema)(await request.json())
      const messages = body.messages ?? []
      const tools = (body.tools ?? []).map((tool) => tool.function?.name)
      const last = messages.at(-1)
      const lastAssistant = messages.findLastIndex((message) => message.role === "assistant")
      const person = messages.slice(lastAssistant + 1).filter((message) => message.role === "user").map((message) => textOf(message.content)).join("\n")
        .replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, "").trim()
      let delta: Delta = { content: "TITLE: Compat chat\nSHORT: Compat" }
      let finish = "stop"
      if (tools.length > 0) {
        if (last?.role === "tool") delta = { content: "COMPAT-ROUTED" }
        else if (tools.includes("route_request") && person.includes(ROUTE_MARK)) {
          calls += 1
          delta = { tool_calls: [{ index: 0, id: `call-${tag}-${calls}`, type: "function", function: { name: "route_request", arguments: JSON.stringify({ kind: "new" }) } }] }
          finish = "tool_calls"
        } else delta = { content: replyTo(person.split("\n")[0] ?? "") }
      }
      return new Response([
        sse({ id: "fixture", object: "chat.completion.chunk", model: FIXTURE_MODEL, choices: [{ index: 0, delta, finish_reason: null }] }),
        sse({ id: "fixture", object: "chat.completion.chunk", model: FIXTURE_MODEL, choices: [{ index: 0, delta: {}, finish_reason: finish }] }),
        sse({ id: "fixture", object: "chat.completion.chunk", model: FIXTURE_MODEL, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
        "data: [DONE]\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { port: server.port ?? 0, stop: () => server.stop(true) }
}

/** Points the account's fixture provider at `port`. Each step starts its own fake model on a new port. */
export function pointAccountAt(userDataRoot: string, port: number): void {
  const file = path.join(userDataRoot, "flywheel.toml")
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/base_url = "http:\/\/127\.0\.0\.1:\d+\/v1"/, `base_url = "http://127.0.0.1:${port}/v1"`))
}

/** Polls `read` until `accept` holds, or fails with `label` and the last value after `ms`. */
export async function until<T>(label: string, read: () => Promise<T>, accept: (value: T) => boolean, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (accept(value)) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}; last value: ${JSON.stringify(value)}`)
    await Bun.sleep(50)
  }
}

/** Opens the temporary project with the code of the checkout at `root`: the production project composition over an
 *  in-process kernel, with this step's log under `logs/<step>`. `close` stops the composition, the fake model, and
 *  the log, and answers the shutdown result. */
export async function openProject(root: string, tempRoot: string, step: string) {
  const dirs = layout(tempRoot)
  const { Log }: typeof import("../../src/infra/log.ts") = await import(path.join(root, "src/infra/log.ts"))
  const logDirectory = path.join(dirs.logBase, step)
  fs.mkdirSync(logDirectory, { recursive: true })
  await Log.init({ dir: logDirectory })
  const { createTestRuntimeComposition }: typeof import("../../tests/helpers/runtime-composition.ts") = await import(path.join(root, "tests/helpers/runtime-composition.ts"))
  const { unguardedSpawnOwned }: typeof import("../../tests/helpers/real-process-fixture.ts") = await import(path.join(root, "tests/helpers/real-process-fixture.ts"))
  const { createPersistentProcessManager }: typeof import("../../src/infra/persistent-process-manager.ts") = await import(path.join(root, "src/infra/persistent-process-manager.ts"))
  const { createLauncherScope }: typeof import("../../src/infra/process-supervisor.ts") = await import(path.join(root, "src/infra/process-supervisor.ts"))
  const { openReadonlyEventReader }: typeof import("../../src/infra/sqlite-event-store.ts") = await import(path.join(root, "src/infra/sqlite-event-store.ts"))
  const { resolveEventStoreDbFile }: typeof import("../../src/infra/paths.ts") = await import(path.join(root, "src/infra/paths.ts"))

  const model = startFakeModel()
  fs.mkdirSync(dirs.project, { recursive: true })
  if (fs.existsSync(path.join(dirs.userDataRoot, "flywheel.toml"))) pointAccountAt(dirs.userDataRoot, model.port)
  else {
    const { writeFixtureAccountConfig }: typeof import("../../tests/integration/local/_fixture-account.ts") = await import(path.join(root, "tests/integration/local/_fixture-account.ts"))
    await writeFixtureAccountConfig(dirs.userDataRoot, { port: model.port, model: FIXTURE_MODEL })
  }
  const persistent = createPersistentProcessManager()
  const composition = await createTestRuntimeComposition({
    executionCwd: dirs.project,
    projectRoot: dirs.project,
    accountHome: dirs.accountHome,
    userDataRoot: dirs.userDataRoot,
    workerUrl: new URL(`file://${path.join(root, "src/orchestration/app-service/worker-entry.ts")}`).href,
    launcher: createLauncherScope({ spawnOwned: unguardedSpawnOwned(), adoptOwned: () => Promise.reject(new Error("no command is adopted here")) }),
    persistentProcesses: persistent.client(),
    allowPersistentProcesses: false,
    interactive: true,
  })
  const client = composition.client
  // The orchestrator finds this record to prove that it reads the step's log.
  Log.create({ service: "lead-store-compat" }).warn(LOG_MARKER, { step })

  /** The text of every assistant message of a chat's conversation, read from the store. */
  const assistantTexts = async (sessionId: string): Promise<readonly string[]> => {
    const reader = openReadonlyEventReader(resolveEventStoreDbFile(dirs.project))
    try {
      const created = (await reader.read({ aggregateId: `session:${sessionId}`, types: ["session.created"] }))[0]
      const conversationId = created && Schema.decodeUnknownSync(SessionCreatedSchema)(created.payload).conversationId
      if (!conversationId) return []
      const facts = await reader.read({ aggregateId: `conversation:${conversationId}`, types: ["chat.entries.appended"] })
      return facts.flatMap((fact) => Schema.decodeUnknownSync(EntriesAppendedSchema)(fact.payload).entries
        .flatMap((entry) => entry.kind === "message" && entry.message?.kind === "assistant" ? [textOf(entry.message.content)] : []))
    } finally {
      reader.close()
    }
  }

  /** Whether no turn runs in the chat: it is idle, or it has no runtime entry, as after the release of a chat that no client shows. */
  const atRest = async (sessionId: string): Promise<boolean> => {
    const activity = (await client.query({ type: "statusSnapshot", sessionIds: [sessionId] })).views[0]?.view?.activity
    return activity === undefined || activity === "idle" || activity === "absent"
  }

  /** Sends the person's `input` to a chat and waits until the chat is idle again and holds the fake model's `expected` text. */
  const turn = async (sessionId: string, input: string, expected: string): Promise<void> => {
    const sent = await client.dispatch({ type: "session.send", sessionId, input })
    if (!sent.ok) throw new Error(`session.send to ${sessionId} was refused: ${JSON.stringify(sent)}`)
    await until(`the reply "${expected}" in ${sessionId}`, () => assistantTexts(sessionId), (texts) => texts.some((text) => text.includes(expected)))
    await until(`${sessionId} at rest`, () => atRest(sessionId), Boolean)
  }

  const close = async () => {
    try {
      return await composition.dispose({ clientsHold: false })
    } finally {
      persistent.releaseAll()
      model.stop()
      await Log.closeGlobal()
    }
  }

  return { client, turn, assistantTexts, atRest, close, dirs }
}
