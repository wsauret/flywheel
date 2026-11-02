import type { ChildSessionControl } from "../../src/orchestration/session/child-session-control"
import type { SessionMessaging } from "../../src/orchestration/session/session-messaging"

/** A test authority with no child to restore. Unspecified reads and controls
 *  throw, so a test that reaches one fails with its name. */
export function unusedChildSessionControl(overrides: Partial<ChildSessionControl> = {}): ChildSessionControl {
  const unused = (name: string) => async (): Promise<never> => { throw new Error(`child control ${name} is not part of this test`) }
  return { restoreTracking: async () => {}, list: unused("list"), status: unused("status"), isChild: unused("isChild"), interrupt: unused("interrupt"), resume: unused("resume"), stop: unused("stop"), ...overrides }
}

/** A messaging authority that a test only has to see: it lists no session,
 *  and a send, a run observation, or a child control fails the test. */
export function unusedSessionMessaging(): SessionMessaging {
  const unused = (): never => { throw new Error("session messaging is not part of this test") }
  return { children: unusedChildSessionControl(), send: unused, list: async () => [], identity: async () => undefined, observeRun: unused }
}
