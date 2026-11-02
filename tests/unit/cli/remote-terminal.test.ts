import { describe, expect, test } from "bun:test"

import { guardRelease } from "../../../src/cli/remote-terminal.js"
import type { TerminalSuccessor } from "../../../src/cli/terminal-handoff.js"
import type { FrontendEvent } from "../../../src/protocol/app-service-types.js"
import type { ReleaseInstall } from "../../../src/protocol/client/runtime-fault-copy.js"
import { RUNTIME_PROTOCOL_VERSION } from "../../../src/protocol/runtime-liveness.js"

/** The in-band release guard of a terminal attached through the relay
 *  (PI-REMOTE-016): the machine updated between presence and the attach, and
 *  its runtime refused this terminal's protocol with its own release. */

const SUCCESSOR: TerminalSuccessor = { command: ["/account/.flywheel/bin/flywheel"], env: {} }

function refusal(version: string, protocolVersion: number): FrontendEvent {
  return { type: "runtime.health", health: { kind: "faulted", since: 1, cause: "refused", refusal: { kind: "protocol-mismatch", version, protocolVersion } } }
}

function harness(install: (version: string) => Promise<TerminalSuccessor | string>) {
  const listeners = new Set<(event: FrontendEvent) => void>()
  const installs: string[] = []
  const followed: TerminalSuccessor[] = []
  const states: (ReleaseInstall | undefined)[] = []
  const guard = guardRelease({
    client: { subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) } },
    terminal: { version: "0.2.0", protocolVersion: RUNTIME_PROTOCOL_VERSION },
    install: async (version) => { installs.push(version); return await install(version) },
    follow: (successor) => { followed.push(successor); return new Promise<never>(() => {}) },
  })
  guard.subscribe((state) => { states.push(state) })
  const emit = (event: FrontendEvent): void => { for (const listener of listeners) listener(event) }
  return { guard, emit, installs, followed, states }
}

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe("the relay terminal's release guard", () => {
  test("a refusal naming a later release installs it, says so, and becomes the installed build", async () => {
    const { emit, installs, followed, states } = harness(async () => SUCCESSOR)
    emit(refusal("0.3.0", RUNTIME_PROTOCOL_VERSION + 1))
    // A second report of the same refusal while installing starts nothing more.
    emit(refusal("0.3.0", RUNTIME_PROTOCOL_VERSION + 1))
    await settled()
    expect(installs).toEqual(["0.3.0"])
    expect(followed).toEqual([SUCCESSOR])
    expect(states).toEqual([undefined, { status: "installing", version: "0.3.0" }])
  })

  test("an install that does not happen says why, for the notice to show", async () => {
    const reason = "Automatic updates are off, so Flywheel 0.3.0 was not installed. Turn them on in Flywheel settings, then open the project again."
    const { emit, followed, states } = harness(async () => reason)
    emit(refusal("0.3.0", RUNTIME_PROTOCOL_VERSION + 1))
    await settled()
    expect(followed).toEqual([])
    expect(states.at(-1)).toEqual({ status: "failed", version: "0.3.0", message: reason })
  })

  test("a refusal naming an earlier release, and any other fault, install nothing", async () => {
    const { emit, installs, states } = harness(async () => SUCCESSOR)
    emit(refusal("0.1.0", RUNTIME_PROTOCOL_VERSION - 1))
    emit({ type: "runtime.health", health: { kind: "faulted", since: 1, cause: "the relay closed the channel" } })
    await settled()
    expect(installs).toEqual([])
    expect(states).toEqual([undefined])
  })
})
