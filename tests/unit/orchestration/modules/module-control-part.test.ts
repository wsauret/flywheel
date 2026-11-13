/** A module whose service runs in execution may declare a control part, which answers in the control placement
 *  without waiting for the executor (ARCH-RUNTIME-050). The account composition builds the control part and the
 *  executor composition leaves it out while an account serves the project; a standalone composition holds both. */

import { describe, expect, it } from "bun:test"
import { NO_MODULE_SERVICES, moduleServiceHandle } from "../../../../src/infra/module-service.js"
import { composeAccountModuleProtocolRuntimes } from "../../../../src/orchestration/app-service/module-protocol-host.js"
import { composeAccountProjectModuleServices, composeModuleProcessServices } from "../../../../src/orchestration/app-service/module-service-host.js"
import { leadModule } from "../../../../src/orchestration/modules/lead/module.js"
import type { FirstPartyModule } from "../../../../src/orchestration/modules.js"
import { kernelPorts } from "../../../helpers/module-kernel.js"

interface Probe {
  readonly part: "execution" | "control"
  dispose(): void
}
const probeService = moduleServiceHandle<Probe>("probe")
const probeControl = moduleServiceHandle<Probe>("probe", "control")

const probeModule = {
  id: "probe",
  dependencies: [],
  availability: { kind: "available" },
  service: { handle: probeService, create: (): Probe => ({ part: "execution", dispose() {} }) },
  control: { service: { handle: probeControl, create: (): Probe => ({ part: "control", dispose() {} }) } },
  contributions: [],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule

const kernel = () => ({ ...kernelPorts(), projectRegistry: { list: async () => [], record: async () => { throw new Error("not used") }, forget: async () => {}, watch: () => () => {} } })
const parts = (services: { readonly get: typeof NO_MODULE_SERVICES.get }) => [services.get(probeService)?.part, services.get(probeControl)?.part]

describe("a control part of an execution module", () => {
  it("is built in the account composition, and the execution service is not", () => {
    const account = composeAccountProjectModuleServices([probeModule], () => ["probe"], kernel())
    account.reconcile()
    expect(parts(account.services)).toEqual([undefined, "control"])
  })

  it("is left out of the executor composition while an account serves the project", () => {
    const executor = composeModuleProcessServices([probeModule], () => ["probe"], kernelPorts(), true)
    executor.reconcile()
    expect(parts(executor.services)).toEqual(["execution", undefined])
  })

  it("is built beside the execution service in a standalone composition", () => {
    const standalone = composeModuleProcessServices([probeModule], () => ["probe"], kernelPorts(), false)
    standalone.reconcile()
    expect(parts(standalone.services)).toEqual(["execution", "control"])
  })

  it("answers its protocol in the account, which leaves the execution protocol to the executor", () => {
    const routes = composeAccountModuleProtocolRuntimes([leadModule], { modules: NO_MODULE_SERVICES, publish: () => undefined, snapshotPosition: () => 0 }, () => ["lead"])
    expect(routes.owns({ type: "lead.open", reason: "launch" })).toBe(true)
    expect(routes.owns({ type: "lead.dismiss", sessionId: "lead-1" })).toBe(true)
    expect(routes.owns({ type: "lead.result.mark_read", sessionId: "chat-1", entryId: "entry-1" })).toBe(false)
  })
})
