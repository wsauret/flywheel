import * as path from "node:path"
import * as fs from "node:fs"

import { CONTINUATION_MESSAGES } from "../../../src/orchestration/agent-runtime/continuation-messages.js"
import { interruptedTurnMessage } from "../../../src/orchestration/session/conversation/turn-end-record.js"
import { interruptedWorkMessage } from "../../../src/orchestration/session/conversation/interrupted-turn-summary.js"
import { quotePowerShell } from "../../../src/orchestration/agent-runtime/tools/bash-script.js"

export const MODEL = "gpt-5"
/** The opening of a runtime interrupt's record, whether or not it cut a tool call. */
const RUNTIME_RECORD = interruptedTurnMessage("runtime", false)
/** The opening of the record recovery writes for a turn whose process died. */
const CRASH_RECORD = interruptedWorkMessage({ finishedTools: [], unconfirmedTools: [], paths: [] }, "crash").split(".")[0] ?? ""

/** The tasks the fixture provider tells apart, each by its text in a user
 *  turn. No task's text contains another's. A child's prompt is its own user
 *  turn; its parent's user turns never carry it. */
export const TASKS = {
  chat: "TASK-CHAT: answer when the fixture releases you",
  child: "TASK-CHILD: read nothing and hand off at once",
  parent: "TASK-PARENT: delegate the fixture work to an explorer",
  ask: "TASK-ASK: ask me before continuing",
  workflow: "TASK-WORKFLOW: investigate the fixture defect",
  stepChild: "TASK-STEP-CHILD: read nothing and hand off at once",
  stepParent: "TASK-STEP-PARENT: specify by delegating to an explorer",
  followUp: "TASK-FOLLOW-UP: answer when the fixture releases you",
  followStep: "TASK-FOLLOW-STEP: investigate the fixture defect",
  shell: "TASK-SHELL: run the fixture command",
  person: "TASK-PERSON: answer when the fixture releases you",
  first: "TASK-FIRST: answer when the fixture releases you",
  second: "TASK-SECOND: answer when the fixture releases you",
  stop: "TASK-STOP: answer when the fixture releases you",
  background: "TASK-BACKGROUND: start the fixture server",
  idleBackground: "TASK-IDLE-BACKGROUND: start the fixture server and stop",
  stepBackground: "TASK-STEP-BACKGROUND: investigate with the fixture server running",
  childBackground: "TASK-CHILD-BACKGROUND: start the fixture server and hand off",
  backgroundParent: "TASK-BACKGROUND-PARENT: delegate the fixture server to a general child",
  childForeground: "TASK-CHILD-FOREGROUND: run the fixture command and hand off",
  foregroundParent: "TASK-FOREGROUND-PARENT: delegate the foreground command to a general child",
  followUpBackground: "TASK-FOLLOW-UP-BACKGROUND: run the fixture server after the workflow",
  cutFirst: "TASK-CUT-FIRST: answer when the fixture releases you",
  holding: "TASK-HOLDING: answer when the fixture releases you",
  cutLimit: "TASK-CUT-LIMIT: answer when the fixture releases you",
  cutKilled: "TASK-CUT-KILLED: answer when the fixture releases you",
  killHolding: "TASK-KILL-HOLDING: answer when the fixture releases you",
  lateChat: "TASK-LATE-CHAT: answer when the fixture releases you",
  lateOpen: "TASK-LATE-OPEN: answer when the fixture releases you",
  lateWorkflow: "TASK-LATE-WORKFLOW: investigate the fixture defect",
  restarted: "TASK-RESTARTED: answer when the fixture releases you",
  serverCutFirst: "TASK-SERVER-CUT-FIRST: answer when the fixture releases you",
  serverHolding: "TASK-SERVER-HOLDING: answer when the fixture releases you",
  admittedServer: "TASK-ADMITTED-SERVER: start the fixture server while the cut settles",
  stopTarget: "TASK-STOP-TARGET: start the fixture server until a person stops it",
  deadline: "TASK-DEADLINE: start the fixture server with a short deadline",
  exitsEarly: "TASK-EXITS-EARLY: start the fixture server that ends between the builds",
  killedExecutor: "TASK-KILLED-EXECUTOR: start the fixture server before its executor dies",
  mutates: "TASK-EDITS: start the fixture command that edits the project in a private copy",
  pausedStep: "TASK-PAUSED-STEP: investigate with the fixture server running until a person pauses the step",
} as const
export type TaskKey = keyof typeof TASKS
// A request takes the first task its user text names.
const TASK_KEYS: readonly TaskKey[] = [
  "chat", "child", "parent", "ask", "workflow", "stepChild", "stepParent", "followUp", "followUpBackground", "followStep", "shell", "person",
  "first", "second", "stop", "background", "idleBackground", "stepBackground", "childBackground", "backgroundParent",
  "childForeground", "foregroundParent",
  "cutFirst", "holding", "cutLimit", "cutKilled", "killHolding", "lateChat", "lateOpen", "lateWorkflow", "restarted",
  "serverCutFirst", "serverHolding", "admittedServer", "stopTarget", "deadline", "exitsEarly", "killedExecutor", "mutates",
  "pausedStep",
]

/** The hard deadline of the deadline task's command, in seconds: long enough
 *  for the replacement and the adoption to finish first. */
export const COMMAND_DEADLINE_SECONDS = 30

/** The project file the edits task's command changes in its private copy, and what it writes there. */
export const EDITED_FILE = "edited.txt"
export const EDITED_CONTENT = "changed by the command"

interface SseData {
  readonly [key: string]: unknown
}

function sse(data: SseData): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

function requestHasTools(body: unknown): boolean {
  return typeof body === "object" && body !== null && "tools" in body && Array.isArray(body.tools) && body.tools.length > 0
}

/** User turns identify the task; tool arguments can contain a child's task. */
function userText(body: unknown): string {
  if (typeof body !== "object" || body === null || !("messages" in body) || !Array.isArray(body.messages)) return ""
  return JSON.stringify(body.messages.filter((message: unknown) => typeof message === "object" && message !== null && "role" in message && message.role === "user"))
}

/** The text of the result of `toolCallId`, if the conversation carries one. */
export function toolResult(body: unknown, toolCallId: string): string | undefined {
  if (typeof body !== "object" || body === null || !("messages" in body) || !Array.isArray(body.messages)) return undefined
  const message: unknown = body.messages.find((candidate: unknown) => typeof candidate === "object" && candidate !== null
    && "role" in candidate && candidate.role === "tool" && "tool_call_id" in candidate && candidate.tool_call_id === toolCallId)
  if (typeof message !== "object" || message === null || !("content" in message)) return undefined
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content)
}

function hasToolResult(body: unknown, toolCallId: string): boolean {
  return toolResult(body, toolCallId) !== undefined
}

function toolCallDelta(id: string, name: string, args: SseData, content?: string): SseData {
  return { ...(content === undefined ? {} : { content }), tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }
}

/** How the fixture answers each task's requests. */
type TaskHandlers = { readonly [key in TaskKey]?: (request: Request, body: unknown, text: string, task: TaskTrace, continued: boolean) => Response }

interface TaskTrace {
  /** Every turn request of the task. */
  requests: number
  /** The Resumes the task's conversation has recorded, counted when the
   *  first request after each arrives. */
  continued: number
  /** Requests whose conversation says the runtime interrupted the turn. */
  runtimeRecorded: number
  /** Requests whose conversation says the turn's process died. */
  crashRecorded: number
  /** Requests that carry the command's completed output, absent from its input. */
  completedCommand: number
  successorCompletedCommand: number
  lastUserText?: string
  /** The whole body of the task's latest request, and of its first continued one. */
  lastBody?: string
  firstContinuedBody?: string
  commandLaunches: number
  /** What the test's probe said when the task's next request after the probe was set arrived. */
  probedAtNextRequest?: boolean
  entered: PromiseWithResolvers<void>
}

const STEP_HANDOFF = {
  summary: "The fixture has no defect.",
  hypothesis: null,
  evidence: ["The fixture provider answered every request it was asked."],
}

/** The one provider every project of the replacement tests talks to. A
 *  task's first turn is held until the replacement cuts it, except where the
 *  task asks a question, runs a command, or delegates first; a continued turn
 *  answers at once unless the test holds continued turns too. Every request
 *  without tools (a title) answers at once. */
export function startReplacementProvider(options: { readonly markerDir: string }) {
  const trace = (): TaskTrace => ({ requests: 0, continued: 0, runtimeRecorded: 0, crashRecorded: 0, completedCommand: 0, successorCompletedCommand: 0, commandLaunches: 0, entered: Promise.withResolvers<void>() })
  const traces = new Map<TaskKey, TaskTrace>(TASK_KEYS.map((key) => [key, trace()]))
  const probes = new Map<TaskKey, () => boolean>()
  const successors = new Set<TaskKey>()
  let holdContinued = false
  const continuedEntered = Promise.withResolvers<void>()
  const never = new Promise<void>(() => {})
  // The shell write policy admits the account's data folder for every
  // project's command, so held commands keep their markers there.
  fs.mkdirSync(options.markerDir, { recursive: true })
  const commandPath = (id: string, suffix: string) => path.join(options.markerDir, `${id}.${suffix}`)
  const utf8NoBom = "[System.Text.UTF8Encoding]::new($false)"
  const started = (id: string) => process.platform === "win32"
    ? `[System.IO.File]::AppendAllText(${quotePowerShell(commandPath(id, "launches"))}, ${quotePowerShell("launch\n")}, ${utf8NoBom}); [System.IO.File]::WriteAllText(${quotePowerShell(commandPath(id, "started"))}, [string]$PID + ${quotePowerShell("\n")}, ${utf8NoBom})`
    : `printf 'launch\\n' >> ${JSON.stringify(commandPath(id, "launches"))}; echo $$ > ${JSON.stringify(commandPath(id, "started"))}`
  // A command's own text never spells `fixture-command-finished`, so only
  // its output, which its completion carries, does.
  const heldCommand = (id: string) => process.platform === "win32"
    ? `${started(id)}; while (-not (Test-Path -LiteralPath ${quotePowerShell(commandPath(id, "release"))})) { Start-Sleep -Milliseconds 50 }; Write-Output ('fixture-command-' + 'finished')`
    : `${started(id)}; while [ ! -e ${JSON.stringify(commandPath(id, "release"))} ]; do sleep 0.05; done; printf '%s%s\\n' fixture-command- finished`
  /** A held command that first changes `EDITED_FILE` in its working directory. */
  const editingCommand = (id: string) => process.platform === "win32"
    ? `[System.IO.File]::WriteAllText(${quotePowerShell(EDITED_FILE)}, ${quotePowerShell(`${EDITED_CONTENT}\n`)}, ${utf8NoBom}); ${heldCommand(id)}`
    : `printf '%s\\n' ${JSON.stringify(EDITED_CONTENT)} > ${EDITED_FILE}; ${heldCommand(id)}`
  const answer = (delta: SseData, finishReason = "stop"): Response => new Response([
    sse({ id: "fixture", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta, finish_reason: null }] }),
    sse({ id: "fixture", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }),
    sse({ id: "fixture", object: "chat.completion.chunk", model: MODEL, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
    "data: [DONE]\n\n",
  ].join(""), { headers: { "content-type": "text/event-stream" } })
  const call = (id: string, name: string, args: SseData, content?: string): Response => answer(toolCallDelta(id, name, args, content), "tool_calls")
  // A held request keeps its stream open with comment frames, so neither the
  // client's idle watchdog nor the replacement's cut is racing a quiet socket.
  const held = (request: Request): Response => {
    const encoder = new TextEncoder()
    let timer: ReturnType<typeof setInterval> | undefined
    return new Response(new ReadableStream({
      start(controller) {
        timer = setInterval(() => {
          try { controller.enqueue(encoder.encode(": keep-alive\n\n")) } catch { clearInterval(timer) }
        }, 1_000)
        request.signal.addEventListener("abort", () => {
          clearInterval(timer)
          try { controller.close() } catch { /* already closed */ }
        })
      },
      cancel() { clearInterval(timer) },
    }), { headers: { "content-type": "text/event-stream" } })
  }
  const delegate = (id: string, persona: string, prompt: string): Response => call(id, "subagent", {
    persona,
    description: "Fixture child",
    rationale: "The fixture proves a replacement continues a real child session.",
    prompt,
  }, "Delegating the fixture task.")
  /** A parent that delegates, waits on its child, and finishes on its result. */
  const parentTurn = (body: unknown, text: string, task: TaskTrace, dispatchId: string, persona: string, prompt: string, finished: () => Response): Response => {
    if (text.includes("subagent_notifications")) return finished()
    if (hasToolResult(body, dispatchId)) return call(`${dispatchId}-wait-${task.requests}`, "process", { action: "wait" })
    return delegate(dispatchId, persona, prompt)
  }
  /** A child held on its first request whose next request hands off. A
   *  resumed child continues its own conversation with no Resume message. */
  const childTurn = (request: Request, body: unknown, task: TaskTrace, handoffId: string, heldAt = 1): Response => {
    if (hasToolResult(body, handoffId)) return answer({ content: "Child finished." })
    if (task.requests === heldAt) {
      task.entered.resolve()
      return held(request)
    }
    return call(handoffId, "handoff", { summary: "Child finished the fixture task." })
  }
  /** A turn that starts a managed command, in the background unless
   *  `background` is false, then answers with `after`. */
  const backgroundTurn = (request: Request, body: unknown, task: TaskTrace, id: string, after: () => Response, launch: { readonly background?: boolean; readonly timeout?: number; readonly command?: string; readonly mutates?: boolean } = {}): Response => {
    if (hasToolResult(body, id)) {
      task.entered.resolve()
      return after()
    }
    task.commandLaunches += 1
    return call(id, "bash", { command: launch.command ?? heldCommand(id), background: launch.background ?? true, ...(launch.timeout === undefined ? {} : { timeout: launch.timeout }), ...(launch.mutates ? { mutates: true } : {}) })
  }
  /** A turn on the successor that parks on its command until the command's
   *  completion reaches it, then answers with `done`. */
  const afterCommand = (body: unknown, task: TaskTrace, id: string, done: () => Response): Response =>
    JSON.stringify(body).includes("fixture-command-finished") ? done() : call(`${id}-wait-${task.requests}`, "process", { action: "wait" })
  /** A chat that starts a held command, is held until the cut, and answers
   *  at once on the successor. */
  const commandChat = (id: string, launch?: Parameters<typeof backgroundTurn>[5]) => (request: Request, body: unknown, _text: string, task: TaskTrace, continued: boolean): Response => continued
    ? answer({ content: "The command keeps running." })
    : backgroundTurn(request, body, task, id, () => held(request), launch)
  const handlers: TaskHandlers = {
    parent: (_request, body, text, task) => parentTurn(body, text, task, "dispatch-1", "explorer", TASKS.child, () => answer({ content: "Parent finished." })),
    child: (request, body, _text, task) => childTurn(request, body, task, "handoff-1"),
    ask: (_request, body, _text, task) => {
      if (hasToolResult(body, "ask-1")) return answer({ content: "Continuing after the answer." })
      task.entered.resolve()
      return call("ask-1", "ask_user", { context: "One decision is needed before this continues.", question: "Proceed?", header: "Go", options: [{ label: "Yes" }, { label: "No" }] })
    },
    workflow: (request, _body, _text, task, continued) => {
      if (continued) return call("step-handoff-1", "handoff", STEP_HANDOFF)
      task.entered.resolve()
      return held(request)
    },
    stepParent: (_request, body, text, task) => parentTurn(body, text, task, "step-dispatch-1", "explorer", TASKS.stepChild, () => {
      task.entered.resolve()
      return call("step-parent-handoff", "handoff", { summary: "The child finished the investigation." })
    }),
    stepChild: (request, body, _text, task) => childTurn(request, body, task, "step-child-handoff"),
    followStep: () => call("follow-step-handoff", "handoff", STEP_HANDOFF),
    // A pending follow-up request runs again on the next build; it carries no
    // Resume message, so its second request is the continued one.
    followUp: (request, _body, _text, task) => {
      if (task.requests > 1) return answer({ content: "Follow-up finished." })
      task.entered.resolve()
      return held(request)
    },
    // A foreground command, which the cut moves to the background.
    shell: commandChat("shell-1", { background: false }),
    background: (request, body, _text, task, continued) => continued
      ? answer({ content: "Background turn finished." })
      : backgroundTurn(request, body, task, "background-1", () => held(request)),
    admittedServer: commandChat("admitted-server-1"),
    stopTarget: commandChat("stop-target-1"),
    deadline: commandChat("deadline-1", { timeout: COMMAND_DEADLINE_SECONDS }),
    exitsEarly: commandChat("exits-early-1"),
    killedExecutor: commandChat("killed-executor-1"),
    mutates: commandChat("edits-1", { command: editingCommand("edits-1"), mutates: true }),
    idleBackground: (request, body, _text, task) => task.requests > 2
      ? successors.has("idleBackground") ? answer({ content: "Idle chat answered." }) : held(request)
      : backgroundTurn(request, body, task, "idle-background-1", () => answer({ content: "The server is running." })),
    followUpBackground: (request, body, _text, task) => successors.has("followUpBackground")
      ? afterCommand(body, task, "follow-up-background", () => answer({ content: "Follow-up command finished." }))
      : backgroundTurn(request, body, task, "follow-up-background-1", () => held(request)),
    // The resumed step parks on its adopted command, then holds its request
    // open, which keeps the attempt open with no further request.
    stepBackground: (request, body, _text, task, continued) => continued
      ? afterCommand(body, task, "step-background", () => held(request))
      : backgroundTurn(request, body, task, "step-background-1", () => held(request)),
    // A resumed child carries no Resume message, so the successor is what
    // tells its continued requests apart.
    childBackground: (request, body, _text, task) => {
      if (hasToolResult(body, "child-background-handoff")) return answer({ content: "Child finished." })
      if (successors.has("childBackground")) return afterCommand(body, task, "child-background", () => call("child-background-handoff", "handoff", { summary: "Child finished the fixture task." }))
      return backgroundTurn(request, body, task, "child-background-1", () => held(request))
    },
    backgroundParent: (_request, body, text, task) => parentTurn(body, text, task, "background-dispatch-1", "general", TASKS.childBackground, () => answer({ content: "Parent finished." })),
    childForeground: (request, body, _text, task) => {
      if (hasToolResult(body, "child-foreground-handoff")) return answer({ content: "Child finished." })
      if (successors.has("childForeground")) return afterCommand(body, task, "child-foreground", () => call("child-foreground-handoff", "handoff", { summary: "Child finished the fixture task." }))
      return backgroundTurn(request, body, task, "child-foreground-1", () => held(request), { background: false })
    },
    foregroundParent: (_request, body, text, task) => parentTurn(body, text, task, "foreground-dispatch-1", "general", TASKS.childForeground, () => answer({ content: "Parent finished." })),
    // A step whose server runs while a person pauses it; resumed on the
    // successor, it parks on a question, which keeps the attempt open.
    pausedStep: (request, body, _text, task) => successors.has("pausedStep")
      ? call("paused-step-ask", "ask_user", { context: "The step resumed.", question: "Continue?", header: "Step", options: [{ label: "Yes" }, { label: "No" }] })
      : backgroundTurn(request, body, task, "paused-step-1", () => held(request)),
    lateWorkflow: (request, _body, _text, task, continued) => {
      if (continued) return call("late-step-handoff", "handoff", STEP_HANDOFF)
      task.entered.resolve()
      return held(request)
    },
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      if (pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [MODEL].map((id) => ({ id, object: "model", created: 0, owned_by: "fixture" })) })
      }
      const body: unknown = await request.json()
      const text = userText(body)
      if (!requestHasTools(body) || text.includes("Generate a session title")) return answer({ content: "TITLE: Fixture session\nSHORT: Fixture" })
      const launch = /FIXTURE-WORKFLOW-LAUNCH:([a-zA-Z]+):([a-zA-Z0-9+/=]+)/.exec(text)
      // The launching chat takes turns of its own after its launch, and the
      // workflow's result it reads there names the workflow's task. Those
      // turns belong to the launcher, or to a later task sent to it, and
      // never to a step of the workflow.
      const launcher = launch !== null && hasToolResult(body, "workflow-launch")
      const key = TASK_KEYS.find((candidate) => text.includes(TASKS[candidate]) && !(launcher && candidate === launch[1]))
      if (launcher && key === undefined) return answer({ content: "The workflow launched." })
      if (launch && key === undefined) {
        const launched = TASK_KEYS.find((candidate) => candidate === launch[1])
        if (!launched || !launch[2]) throw new Error("Invalid fixture workflow launch")
        return call("workflow-launch", "workflow", { source: { kind: "content", content: Buffer.from(launch[2], "base64").toString("utf8") }, description: TASKS[launched], summary: TASKS[launched] })
      }
      const task = key === undefined ? undefined : traces.get(key)
      if (key === undefined || !task) return answer({ content: "Fixture reply." })
      task.requests += 1
      task.lastUserText = text
      const whole = JSON.stringify(body)
      task.lastBody = whole
      const resumes = text.split(CONTINUATION_MESSAGES.resumed).length - 1
      const continued = resumes > 0
      if (resumes > task.continued) {
        task.continued = resumes
        task.firstContinuedBody ??= whole
      }
      const probe = probes.get(key)
      if (probe) {
        probes.delete(key)
        task.probedAtNextRequest = probe()
      }
      if (whole.includes(RUNTIME_RECORD)) task.runtimeRecorded += 1
      if (whole.includes(CRASH_RECORD)) task.crashRecorded += 1
      if (whole.includes("fixture-command-finished")) {
        task.completedCommand += 1
        if (successors.has(key)) task.successorCompletedCommand += 1
      }
      if (continued && holdContinued) {
        continuedEntered.resolve()
        await never
      }
      const handler = handlers[key]
      if (handler) return handler(request, body, text, task, continued)
      if (continued) return answer({ content: `${key} finished.` })
      task.entered.resolve()
      return held(request)
    },
  })
  if (server.port === undefined) throw new Error("fixture provider did not bind a port")
  const get = (key: TaskKey): TaskTrace => {
    const task = traces.get(key)
    if (!task) throw new Error(`no trace for ${key}`)
    return task
  }
  return {
    port: server.port,
    trace: get,
    commandStarted: (id: string) => fs.existsSync(commandPath(id, "started")),
    commandPid: (id: string) => Number(fs.readFileSync(commandPath(id, "started"), "utf8").trim()),
    commandLaunchCount: (id: string) => fs.readFileSync(commandPath(id, "launches"), "utf8").trim().split("\n").length,
    continueOnSuccessor: (key: TaskKey) => { successors.add(key) },
    releaseCommand: (id: string) => { fs.writeFileSync(commandPath(id, "release"), "") },
    entered: (key: TaskKey) => get(key).entered.promise,
    /** Runs `probe` once, when `key`'s next request arrives. */
    probeAtNextRequest: (key: TaskKey, probe: () => boolean) => { probes.set(key, probe) },
    /** From now on every continued request is held, and the first one resolves this. */
    holdContinuedRequests: () => { holdContinued = true; return continuedEntered.promise },
    answerContinuedRequests: () => { holdContinued = false },
    stop: () => { server.stop(true) },
  }
}

export type ReplacementProvider = ReturnType<typeof startReplacementProvider>
