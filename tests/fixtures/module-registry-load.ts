// A process entry that reads the module catalog the way every composing
// entry of the binary does: through the real loader, with no test preload.
// The loaded code reads the catalog while it loads, as the headless host
// registration does at import time, so a loader that published the
// registries only after the load would fail here. It prints what each read
// returned.
import { importComposing } from "../../src/cli/composition/module-registries.js"

const read = await importComposing(async () => {
  const { HEADLESS_MODULE_CEILING } = await import("../../src/orchestration/app-service/headless/host-registration.js")
  const { installedCredentialProviderModules, installedModules } = await import("../../src/orchestration/module-contract/module-catalog.js")
  const credentialProviders = installedCredentialProviderModules().map((module) => module.id)
  const others = installedModules().map((module) => module.id).filter((id) => !credentialProviders.includes(id))
  return { headless: HEADLESS_MODULE_CEILING, credentialProviders, others }
})
console.log(JSON.stringify(read))
