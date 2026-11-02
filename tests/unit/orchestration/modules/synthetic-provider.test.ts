/** The provider contract, proven with providers the hosts have never heard
 *  of: one declares an API key with a prefix and a numeric setting, the
 *  other a device-code login. Each reaches the auth flag table, the key
 *  check, the login registry, and the config view from its definition alone,
 *  with no edit in `src/cli/`, the auth actions, or the config projection. */

import { describe, expect, it } from "bun:test"
import { apiKeyRejectionReason, type AccessProviderDefinition } from "../../../../src/infra/llm/access-provider.js"
import { AUTH_OPERATIONS, runAuth, type AuthCommandDependencies } from "../../../../src/cli/auth.js"
import { accessProviderRegistry } from "../../../../src/orchestration/agent-runtime/llm/access-provider-registry.js"
import type { AccessProviderFactory } from "../../../../src/orchestration/agent-runtime/llm/client-factory.js"
import { projectRuntimeConfig } from "../../../../src/orchestration/app-service/runtime-config-projection.js"
import { providerLoginFlow } from "../../../../src/orchestration/auth/auth-actions.js"
import { CONFIG_DEFAULTS } from "../../../../src/orchestration/config/schema.js"
import { anthropicApiModule } from "../../../../src/orchestration/modules/provider-anthropic-api/module.js"
import { composeFirstPartyModules, installedProviderSettings, type FirstPartyModule } from "../../../../src/orchestration/modules.js"
import { testDirectories } from "../../../helpers/directories.js"
import { refusingLauncher } from "../../../helpers/launcher-fake.js"

const REQUEST_CAP = { control: "number", key: "request_cap", label: "Probe request cap", description: "Requests a profile sends through Probe each day. 0 means no cap.", min: 0, max: 10_000, off: 0, defaultValue: 40, group: "Model providers" } as const

/** No case here plans a request, so a client is never built. */
const neverBuilt: AccessProviderFactory = () => Promise.reject(new Error("no case constructs a probe client"))

const keyDefinition = {
  id: "probe_key",
  displayName: "Probe API Key",
  shortName: "Probe",
  rank: 90,
  supportedFamilies: ["openai"],
  configHints: [],
  catalogId: undefined,
  cli: { flag: "probe-key", name: "Probe" },
  auth: { kind: "api_key", statusRank: 90, keyPrefix: { prefix: "pk-", description: "a Probe API key" } },
  staticModelUnavailableReason: () => undefined,
  billing: "metered",
  spendMode: "direct_api",
} as const satisfies AccessProviderDefinition

const seatDefinition = {
  id: "probe_seat",
  displayName: "Probe Seat",
  shortName: "Probe",
  rank: 91,
  supportedFamilies: ["openai"],
  configHints: [],
  catalogId: undefined,
  cli: { flag: "probe-seat", name: "Probe seat" },
  auth: { kind: "oauth", credentialId: "probe_seat", flow: "device-code", statusRank: 91, start: () => Promise.reject(new Error("no case starts the probe login")) },
  staticModelUnavailableReason: () => undefined,
  billing: "subscription",
} as const satisfies AccessProviderDefinition

const probeKeyModule = {
  id: "provider-probe-key",
  dependencies: [],
  availability: { kind: "available" },
  contributions: [
    { domain: "providers", id: keyDefinition.id, value: { definition: keyDefinition, createClient: neverBuilt } },
    { domain: "settings", id: "provider-probe-key", value: { control: "binary", group: "Model providers", label: keyDefinition.displayName, description: "Allow models through Probe" } },
    { domain: "settings", id: `provider-probe-key:${REQUEST_CAP.key}`, value: REQUEST_CAP },
  ],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule

const probeSeatModule = {
  id: "provider-probe-seat",
  dependencies: [],
  availability: { kind: "available" },
  contributions: [
    { domain: "providers", id: seatDefinition.id, value: { definition: seatDefinition, createClient: neverBuilt } },
  ],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule

const composition = composeFirstPartyModules([probeKeyModule, probeSeatModule, anthropicApiModule])
const definitions = accessProviderRegistry(composition).selection.definitions

describe("a synthetic provider under the provider contract", () => {
  it("composes its flag into the auth command table from its definition's cli field", async () => {
    const lines: string[] = []
    const deps: AuthCommandDependencies = {
      composition: () => composition,
      actions: AUTH_OPERATIONS,
      prompt: () => Promise.resolve(""),
      resolveKey: () => Promise.resolve(undefined),
      settleCatalog: () => Promise.resolve(),
      openBrowser: () => Promise.resolve(true),
      launcher: refusingLauncher,
      log: (...args) => lines.push(args.map(String).join(" ")),
      error: (...args) => lines.push(args.map(String).join(" ")),
      exit: () => { throw new Error("process.exit") },
    }
    await runAuth([], testDirectories("/scratch"), deps)
    const usage = lines.join("\n")
    expect(usage).toContain("login --probe-key")
    expect(usage).toContain("Authenticate with Probe (API key)")
    expect(usage).toContain("logout --probe-seat")
    expect(usage).toContain("Remove Probe seat (device code) credentials")
  })

  it("claims keys by its declared prefix in the shared key check", () => {
    expect(apiKeyRejectionReason(definitions, "anthropic_api", "pk-secret")).toContain("a Probe API key")
    expect(apiKeyRejectionReason(definitions, "probe_key", "sk-ant-secret")).toContain("Anthropic API Key")
    expect(apiKeyRejectionReason(definitions, "probe_key", "pk-secret")).toBeUndefined()
  })

  it("answers the login registry with its declared flow and nothing for an API key", () => {
    expect(providerLoginFlow("probe_seat", definitions)?.flow).toBe("device-code")
    expect(providerLoginFlow("probe_key", definitions)).toBeUndefined()
  })

  it("carries its numeric setting into every profile of the config view under its own table", () => {
    const declared = installedProviderSettings([probeKeyModule, probeSeatModule])
    expect(declared).toEqual([{ ...REQUEST_CAP, providerId: "probe_key" }])
    const view = projectRuntimeConfig({
      revision: 1,
      config: {
        ...CONFIG_DEFAULTS,
        profiles: {
          work: { roles: {}, git_ai_attribution: false, allow_training_routes: false, providers: { probe_key: { request_cap: 12 } } },
          home: { roles: {}, git_ai_attribution: false, allow_training_routes: false, providers: {} },
        },
      },
      warnings: [],
      diagnostics: [],
      sourceIdentity: "probe",
      status: { kind: "valid" },
    }, "/scratch/project", declared)
    expect(view.values.profiles.work?.providers).toEqual({ probe_key: { request_cap: 12 } })
    expect(view.values.profiles.home?.providers).toEqual({ probe_key: { request_cap: REQUEST_CAP.defaultValue } })
  })
})
