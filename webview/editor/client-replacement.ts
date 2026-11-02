import type { CapabilityRequest } from "../../src/protocol/client/editor-host.js"
import { HOST_CONTRACT_VERSION } from "../../src/protocol/client/host-contract.js"
import { ClientHostUpgradeRequired } from "../src/client/input-reload.js"

/** Negotiates replacement before sending any vocabulary an older host cannot serve. */
export function editorClientReplacement(invoke: (request: CapabilityRequest) => Promise<void>, hostContract: number, generation: number) {
  let transactionId = 0
  return {
    async prepare(): Promise<void> {
      if (!(hostContract >= HOST_CONTRACT_VERSION)) throw new ClientHostUpgradeRequired()
      await invoke({ name: "prepareReload", generation, transactionId: ++transactionId })
    },
    commit: () => invoke({ name: "commitReload", generation, transactionId }),
  }
}
