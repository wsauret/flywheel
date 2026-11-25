import { randomUUID } from "node:crypto"

import type { ServeLane } from "../../../infra/cli-subprocess.js"
import { errorMessage } from "../../../infra/error-message.js"
import { Log } from "../../../infra/diagnostics/log.js"
import type { MutationResult, RuntimeRestartReadiness } from "../../../protocol/runtime/app-service-types.js"
import { RESTART_UNCHECKED_REASON } from "../../../protocol/client/runtime/service-restart-copy.js"
import type { ProjectServiceState } from "./projects/project-control-client.js"
import type { ReplacementOwner } from "./replacement-owner.js"

const log = Log.create({ service: "service-restart" })

/** A person's restart of the account service from a client that cannot
 *  start a service itself, such as a phone (PI-INTERACTION-048). It moves
 *  the service exactly as the terminal's restart does, through the one
 *  replacement owner, so running work continues as after an update. */
export function createServiceRestart(deps: {
  readonly lane: ServeLane
  /** Why nothing would start a successor once the service retires, in words
   *  a person reads, or undefined when something does. */
  readonly refusal: () => string | undefined
  readonly replacement: Pick<ReplacementOwner, "request" | "state" | "subscribe">
}): Pick<ProjectServiceState, "restartReadiness" | "restart"> {
  const serviceStart = randomUUID()
  const readiness = (): RuntimeRestartReadiness => {
    const reason = deps.refusal()
    return reason === undefined ? { kind: "ready", serviceStart } : { kind: "unavailable", reason, serviceStart }
  }
  return {
    restartReadiness: readiness,
    async restart(): Promise<MutationResult> {
      const current = readiness()
      if (current.kind === "unavailable") {
        log.info("a client's restart request was refused: nothing would start the account service again", { lane: deps.lane })
        return { ok: false, error: current.reason }
      }
      if (deps.replacement.state.kind !== "none") return { ok: true }
      // The request is accepted once the owner leaves `none`: it holds the
      // request while blockers delay it, or its drain has begun. The answer
      // goes back then, never only once the drain ends, and the stop waits
      // for the turn after this answer, so the answer is written to the
      // client's connection before the listener withdraws.
      const accepted = Promise.withResolvers<boolean>()
      const answered = Promise.withResolvers<void>()
      const unsubscribe = deps.replacement.subscribe((state) => { if (state.kind !== "none") accepted.resolve(true) })
      deps.replacement.request({ kind: "restart requested" }, () => answered.promise).then(
        () => accepted.resolve(deps.replacement.state.kind !== "none"),
        (error: unknown) => {
          log.warn("a client's restart request failed", { lane: deps.lane, error: errorMessage(error) })
          accepted.resolve(false)
        },
      )
      try {
        if (await accepted.promise) return { ok: true }
        // The owner read no blockers, so it holds no request and stops nothing.
        log.info("a client's restart request was not accepted: the running work could not be checked", { lane: deps.lane })
        return { ok: false, error: RESTART_UNCHECKED_REASON }
      } finally {
        unsubscribe()
        setTimeout(() => answered.resolve(), 0)
      }
    },
  }
}
