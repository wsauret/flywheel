import { EXECUTABLE_ROLES } from "./executable-roles.js"
import { connectInternalProcessChannel, type InternalProcessEndpoint } from "./internal-process-channel.js"

// The Antigravity engine's PreInvocation hook runs this client once per model
// step (ARCH-PROVIDERS-087). It lives outside the provider module's home
// because the executable's role table reaches it before any composition loads,
// and the role table may not import a module home.

/** What the client asks the step gate about one PreInvocation. `gateId` is the
 *  login gate id from the hook command, which the gate checks before routing
 *  by `conversationId` (the engine's ACP session id). */
export interface GateQuery {
  readonly gateId: string
  readonly conversationId: string
  readonly invocationNum: number
}

/** The step gate's answer to one query. */
export interface GateAnswer {
  readonly decision: GateDecision
}

type GateDecision = "allow" | "terminate"

/** The hook timeout that `hooks.json` states, in seconds, which the engine
 *  enforces by killing the hook process. */
export const GATE_HOOK_TIMEOUT_SECONDS = 10

/** The client's own deadline. It is well inside the hook timeout, including
 *  the time the executable takes to start, so a gate that does not answer
 *  makes the client print terminate before the engine kills it: a killed hook
 *  lets the step proceed. */
export const GATE_HOOK_DEADLINE_MS = 5_000

// The documented PreInvocation outputs. An object without
// `terminationBehavior` proceeds to the model call. The terminate form injects
// no step, so the engine shows no text for a refused step.
const HOOK_OUTPUT = {
  allow: "{}\n",
  terminate: `${JSON.stringify({ injectSteps: [], terminationBehavior: "terminate" })}\n`,
} as const

/** Answers one PreInvocation hook call: reads the hook payload from `stdin`,
 *  asks the step gate at `address`, and writes the gate's decision through
 *  `write`. A malformed payload (no gate connection is opened), a missing
 *  address or gate id, a gate that cannot be reached, closes, or answers
 *  anything but a decision, and a deadline of `deadlineMs` all write the
 *  terminate decision. It never throws. */
export async function runGateHook(options: {
  readonly stdin: ReadableStream<Uint8Array>
  readonly write: (text: string) => Promise<void>
  readonly address: string | undefined
  readonly loginGateId: string | undefined
  readonly deadlineMs: number
}): Promise<void> {
  const decision = await decideWithin(options).catch((): GateDecision => "terminate")
  await options.write(HOOK_OUTPUT[decision])
}

/** The role entry: `--internal-role=antigravity-gate <gate address> <login gate id>`. */
export async function runGateHookMain(argv: readonly string[]): Promise<never> {
  const at = argv.indexOf(EXECUTABLE_ROLES.antigravityGate)
  await runGateHook({
    stdin: Bun.stdin.stream(),
    write: async (text) => { await Bun.write(Bun.stdout, text) },
    address: argv[at + 1],
    loginGateId: argv[at + 2],
    deadlineMs: GATE_HOOK_DEADLINE_MS,
  })
  process.exit(0)
}

async function decideWithin(options: Parameters<typeof runGateHook>[0]): Promise<GateDecision> {
  const reader = options.stdin.getReader()
  let finished = false
  let endpoint: InternalProcessEndpoint<GateQuery, GateAnswer> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<GateDecision>((resolve) => { timer = setTimeout(() => resolve("terminate"), options.deadlineMs) })
  const ask = async (): Promise<GateDecision> => {
    const payload = preInvocation(await readText(reader))
    const { address, loginGateId } = options
    // Cancelling the reader at the deadline can end the read with a complete
    // payload, after the decision is already made.
    if (finished || !payload || !address || !loginGateId) return "terminate"
    const connected = await connectInternalProcessChannel<GateQuery, GateAnswer>({ path: address, decode: gateAnswer })
    // The deadline may have won while the connection opened, after the
    // cleanup below already ran.
    if (finished) {
      connected.close("gate hook deadline passed")
      return "terminate"
    }
    endpoint = connected
    const answer = new Promise<GateDecision>((resolve) => {
      connected.onMessage((message) => resolve(message.decision))
      connected.onClose(() => resolve("terminate"))
    })
    await connected.send({ gateId: loginGateId, ...payload })
    return answer
  }
  try {
    return await Promise.race([ask(), deadline])
  } finally {
    finished = true
    clearTimeout(timer)
    endpoint?.close("gate hook answered")
    void reader.cancel().catch(() => {})
  }
}

async function readText(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = []
  for (let read = await reader.read(); !read.done; read = await reader.read()) chunks.push(read.value)
  return new TextDecoder().decode(Buffer.concat(chunks))
}

/** The fields the gate needs from the engine's PreInvocation payload, or
 *  undefined when the payload is not one. */
function preInvocation(text: string): Omit<GateQuery, "gateId"> | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null || !("conversationId" in value) || !("invocationNum" in value)) return undefined
  const { conversationId, invocationNum } = value
  if (typeof conversationId !== "string" || conversationId === "") return undefined
  if (typeof invocationNum !== "number" || !Number.isSafeInteger(invocationNum) || invocationNum < 0) return undefined
  return { conversationId, invocationNum }
}

function gateAnswer(value: unknown): GateAnswer | undefined {
  if (typeof value !== "object" || value === null || !("decision" in value)) return undefined
  const { decision } = value
  return decision === "allow" || decision === "terminate" ? { decision } : undefined
}
