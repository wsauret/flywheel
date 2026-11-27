import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { onProviderOptInChange } from "../../../../src/orchestration/config/models/access-provider-registry.js"
import { createRuntimeConfigOwner } from "../../../../src/orchestration/config/runtime-config-owner.js"
import { globalConfigFile } from "../../../../src/infra/platform/files/paths.js"
import { composeFirstPartyModules } from "../../../../src/orchestration/module-contract/module-composition.js"
import { SHIPPED_MODULES } from "../../../../scripts/shipped-modules.js"
import { temporaryDirectories } from "../../../helpers/directories.js"

const directory = temporaryDirectories()

describe("a change of a profile's provider opt-in (ARCH-PROVIDERS-088)", () => {
  test("names each profile whose turned-off providers changed, where a profile that the file does not author keeps them off", async () => {
    const userDataRoot = directory("provider-opt-in-")
    const file = globalConfigFile(userDataRoot)
    writeFileSync(file, "", { mode: 0o600 })
    const owner = await createRuntimeConfigOwner({ userDataRoot, watch: false })
    const changed: string[] = []
    const unsubscribe = onProviderOptInChange(owner, () => composeFirstPartyModules(SHIPPED_MODULES, []), (profileId) => { changed.push(profileId) })
    try {
      // The first opt-in of a profile with no overlay, and an overlay that changes nothing the opt-in reads.
      writeFileSync(file, "[profiles.work]\nallow_google_antigravity = true\n\n[profiles.home]\nallow_training_routes = true\n")
      await owner.refresh()
      expect(changed).toEqual(["work"])
      // The removal of an overlay that held only the opt-in turns the provider off again.
      writeFileSync(file, "[profiles.home]\nallow_training_routes = true\n")
      await owner.refresh()
      expect(changed).toEqual(["work", "work"])
    } finally {
      await unsubscribe()
      await owner.dispose()
    }
  })
})
