import { createClientActions, type ClientActions } from "../client/actions.js"
import { fakeRuntimeConnection } from "../client/runtime-connection-fixture.js"
import { fakeRuntimeSession } from "./client-context-fixture.js"

/** The real actions layer's owner of running actions, for a fixture that
 *  renders controls over a partial client. Work run through it starts,
 *  joins, and settles as in the app; a failure without its own words goes to
 *  `report`. */
export function actionOwner(report: (message: string) => void = () => {}): Pick<ClientActions, "run" | "runInOrder" | "working" | "commandWorking" | "sessionWorking"> {
  const { run, runInOrder, working, commandWorking, sessionWorking } = createClientActions({
    session: fakeRuntimeSession(),
    connection: fakeRuntimeConnection(),
    capabilities: {},
    report: (_severity, message) => report(message),
    captureSurfaceOpener: () => () => {},
  })
  return { run, runInOrder, working, commandWorking, sessionWorking }
}
