import { expect, spyOn, test } from "bun:test"
import { NativeSession } from "@opentui/core"
import type { AttachedRuntimeClient } from "../../../src/protocol/app-service-types.js"
import { startTUI, type TUIOptions } from "../../../src/tui/app.js"
import { refusingLauncher } from "../../helpers/launcher-fake.js"
import { runtimeQuery } from "../../helpers/runtime-dispatch.js"

const refuse = (call: string) => (): never => { throw new Error(`failed renderer creation never calls ${call}`) }

/** A runtime this startup never reaches: the renderer fails before the shell reads it. */
const unreachedRuntime: AttachedRuntimeClient = {
  query: runtimeQuery({}, refuse("query")),
  dispatch: refuse("dispatch"),
  subscribe: refuse("subscribe"),
  close: async () => {},
  onLane: refuse("onLane"),
  watchOutput: refuse("watchOutput"),
}

test("releases the unattached native session and rejects startup when renderer creation fails", async () => {
  const sessions = new Set<NativeSession>()
  const attachment = spyOn(NativeSession.prototype, "attachRenderer").mockImplementation(function (this: NativeSession) {
    sessions.add(this)
    throw new Error("renderer attachment failed")
  })
  const options: TUIOptions = {
    mode: "dark",
    projectRoot: "/scratch/project",
    stateRoot: "/scratch/project",
    userDataRoot: "/scratch/account/.flywheel",
    accountHome: "/scratch/account",
    appVersion: "0.0.0",
    attach: { kind: "local", lane: "installed", restart: async () => refuse("restart")() },
    appService: unreachedRuntime,
    launcher: refusingLauncher,
    attachedIdentity: Promise.resolve(undefined),
  }
  try {
    await expect(startTUI(options)).rejects.toThrow("renderer attachment failed")
    expect(sessions.size).toBe(1)
    const session = [...sessions][0]!
    expect(session.disposed).toBe(true)
    expect(session.contextDisposed).toBe(true)
  } finally {
    attachment.mockRestore()
    for (const session of sessions) session.dispose()
  }
})
