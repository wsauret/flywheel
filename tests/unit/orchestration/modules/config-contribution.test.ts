/** The `config` contribution contract, proven with a module the runtime has
 *  never heard of: it owns one retained section of the configuration file,
 *  the loader decodes that section beside the kernel's, the section never
 *  enters the kernel config view, and its only reader, the module's service,
 *  is not built while the module is off. */

import { describe, expect, it } from "bun:test"
import { Effect, Schema } from "effect"
import { composeModules } from "../../../../src/infra/module-descriptor.js"
import { moduleServiceHandle } from "../../../../src/infra/module-service.js"
import { composeModuleProcessServices, type ModuleProcessServices } from "../../../../src/orchestration/app-service/module-service-host.js"
import { projectRuntimeConfig } from "../../../../src/orchestration/app-service/runtime-config-projection.js"
import { configSection, type ModuleConfigSection } from "../../../../src/orchestration/config/config-section.js"
import { CONFIG_DEFAULTS, flywheelConfigKeys, installedConfigSchema, type FlywheelConfig } from "../../../../src/orchestration/config/schema.js"
import { settingDefinitions } from "../../../../src/orchestration/config/setting-definitions.js"
import type { FirstPartyModule } from "../../../../src/orchestration/modules.js"
import { installedConfigSections } from "../../../../src/orchestration/module-catalog.js"
import { kernelPorts } from "../../../helpers/module-kernel.js"

const ProbeSectionSchema = Schema.Struct({
  greeting: Schema.String.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed("hello"))),
}).pipe(Schema.withDecodingDefaultType(Effect.succeed({ greeting: "hello" })))

const probeSection = {
  key: "probe",
  schema: ProbeSectionSchema,
  owner: "probe greeting",
  applications: [{ mode: "replace-resource", path: [] }],
  protocolExposure: "secret",
  ownerIssues: (raw) => typeof raw === "object" && raw !== null && "shout" in raw ? [{ path: ["probe"], message: "found shout; expected greeting" }] : [],
} as const satisfies ModuleConfigSection<typeof ProbeSectionSchema>

interface ProbeService {
  readonly greeting: string
  dispose(): void
}
const probeService = moduleServiceHandle<ProbeService>("probe")

const probeModule = {
  id: "probe",
  dependencies: [],
  availability: { kind: "available" },
  service: { handle: probeService, create: (services: ModuleProcessServices): ProbeService => ({ greeting: configSection(services.config.snapshot().config, probeSection).greeting, dispose() {} }) },
  contributions: [{ domain: "config", id: probeSection.key, value: probeSection }],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule

const catalog: readonly FirstPartyModule[] = [probeModule]

function kernelOver(config: FlywheelConfig): Omit<ModuleProcessServices, "modules" | "enabled"> {
  const owner: ModuleProcessServices["config"] = {
    snapshot: () => ({ revision: 0, config, warnings: [], diagnostics: [], sourceIdentity: "test", status: { kind: "valid" } }),
    subscribe: () => async () => {},
    mutateSection: async () => { throw new Error("the probe service does not write its section") },
  }
  return kernelPorts({ config: owner })
}

describe("a synthetic module under the config contribution contract", () => {
  it("composes the section into the setting definitions, the recognized root keys, and the loader schema", () => {
    expect(installedConfigSections(catalog)).toEqual([probeSection])
    expect(settingDefinitions(catalog).find((definition) => definition.id === "probe")).toMatchObject({ kind: "retained-section", key: "probe", owner: "probe greeting", protocolExposure: "secret" })
    expect(flywheelConfigKeys(catalog).at(-1)).toBe("probe")
    const decoded = Schema.decodeUnknownSync(installedConfigSchema(catalog))({ probe: { greeting: "hi" } })
    expect(configSection(decoded, probeSection)).toEqual({ greeting: "hi" })
    expect(decoded.show_thinking).toBe(CONFIG_DEFAULTS.show_thinking)
  })

  it("reads the section's own default from a config that carries none, and never projects it into the kernel view", () => {
    expect(configSection(CONFIG_DEFAULTS, probeSection)).toEqual({ greeting: "hello" })
    const view = projectRuntimeConfig({ revision: 1, config: Schema.decodeUnknownSync(installedConfigSchema(catalog))({ probe: { greeting: "private" } }), warnings: [], diagnostics: [], sourceIdentity: "test", status: { kind: "valid" } }, "/scratch/project")
    expect(JSON.stringify(view)).not.toContain("private")
    expect(view.values).not.toHaveProperty("probe")
  })

  it("refuses a contribution whose id is not its section key", () => {
    const mismatched: FirstPartyModule = { ...probeModule, contributions: [{ domain: "config", id: "other", value: probeSection }] }
    expect(() => installedConfigSections([mismatched])).toThrow("Config contribution id other must equal its section key probe")
  })

  it("builds the section's reader only while the module is on", () => {
    const config = Schema.decodeUnknownSync(installedConfigSchema(catalog))({ probe: { greeting: "hi" } })
    const on = composeModuleProcessServices(catalog, () => composeModules(catalog).enabledModuleIds, kernelOver(config))
    on.reconcile()
    expect(on.services.get(probeService)?.greeting).toBe("hi")
    const off = composeModuleProcessServices(catalog, () => composeModules(catalog, { disabledModuleIds: ["probe"] }).enabledModuleIds, kernelOver(config))
    off.reconcile()
    expect(off.services.get(probeService)).toBeUndefined()
  })
})
