import type { RuntimeExecutorState, RuntimeHealth, RuntimeServiceState, RuntimeTransportHealth } from "../app-service-types.js"

/** The one runtime condition a surface renders, from the connection's own
 *  health and the `service` and `executor` states the runtime last published,
 *  ranked by what the person can act on. A connection fault wins: a runtime
 *  that does not answer says nothing current. Sessions that could not be
 *  restored come next, because that fault asks the person to act. The
 *  service's crash loop outranks a project process that Flywheel starts
 *  again, because the account service serves that process. */
export function runtimeHealth(transport: RuntimeTransportHealth, service: RuntimeServiceState, executor: RuntimeExecutorState): RuntimeHealth {
  if (transport.kind === "faulted") return transport
  if (executor.kind === "recovery_failed") return executor
  if (service.kind !== "serving") return service
  if (executor.kind !== "serving") return executor
  return transport
}
