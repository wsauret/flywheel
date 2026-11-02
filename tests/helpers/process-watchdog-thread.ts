import { HARD_EXIT_CLOCK_URL } from "../../src/infra/hard-exit-clock.js"
import type { ThreadProcessProbe } from "../../src/infra/owned-subprocess-backend.js"
import { terminationRecordLine } from "../../src/infra/process-container.js"
import { processWatchdogThread } from "../../src/infra/process-watchdog.js"

/** The process watchdog's Worker body, run on this thread. */
export interface WatchdogThread {
  /** Delivers one message from the host, as the Worker receives it. */
  send(message: unknown): void
  /** Resolves once the thread tells its host that the parent is lost. */
  readonly parentLost: Promise<void>
  /** The line the hard-exit clock is armed to write when its bound expires,
   *  or undefined while the clock is not armed with one. */
  armedDecision(): string | undefined
  /** Gives back the Worker globals that the thread body was given. */
  restore(): void
}

/** Runs the watchdog's Worker body on this thread, with the arguments its
 *  Worker source gives it, a parent probe that answers from `probe`, and a
 *  hard-exit clock that only keeps what it was armed with. The clock never
 *  fires, so no process is signalled. Call `restore` when done. */
export function startWatchdogThread(probe: ThreadProcessProbe = { identify: () => ({ kind: "absent" }) }): WatchdogThread {
  const listen = Object.getOwnPropertyDescriptor(globalThis, "addEventListener")
  const post = Object.getOwnPropertyDescriptor(globalThis, "postMessage")
  const lost = Promise.withResolvers<void>()
  let deliver: (event: MessageEvent) => void = () => {}
  let armed: unknown
  const clock = { postMessage: (message: unknown) => { armed = message }, addEventListener() {}, terminate() {} }
  Object.defineProperty(globalThis, "addEventListener", { configurable: true, writable: true, value: (_type: string, listener: (event: MessageEvent) => void) => { deliver = listener } })
  Object.defineProperty(globalThis, "postMessage", {
    configurable: true,
    writable: true,
    value: (message: unknown) => {
      if (typeof message === "object" && message !== null && "kind" in message && message.kind === "parent-died") lost.resolve()
    },
  })
  processWatchdogThread(1, probe, () => clock, HARD_EXIT_CLOCK_URL, () => {}, terminationRecordLine)
  return {
    send: (message) => { deliver(new MessageEvent("message", { data: message })) },
    parentLost: lost.promise,
    armedDecision: () => (typeof armed === "object" && armed !== null && "decision" in armed && typeof armed.decision === "string" ? armed.decision : undefined),
    restore() {
      if (listen) Object.defineProperty(globalThis, "addEventListener", listen)
      if (post) Object.defineProperty(globalThis, "postMessage", post)
    },
  }
}

/** The decision line that a watchdog armed by `armedBy` gives its hard-exit
 *  clock to write, for a process `processPid` in the container that
 *  `containerPid` leads. */
export function hardExitDecision(input: { readonly processPid: number; readonly containerPid: number; readonly hardExitMs: number; readonly armedBy: string }): string | undefined {
  const thread = startWatchdogThread()
  try {
    thread.send({ kind: "init", processPid: input.processPid, parentPid: 0, containerPid: input.containerPid, hardExitMs: input.hardExitMs })
    thread.send({ kind: "arm", armedBy: input.armedBy })
    return thread.armedDecision()
  } finally {
    thread.restore()
  }
}
