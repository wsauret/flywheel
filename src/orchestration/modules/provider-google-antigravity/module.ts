import { antigravityEnginePath } from "../../../infra/antigravity-engine.js"
import { pinnedAntigravityBytes } from "../../../infra/distribution/antigravity-engine-pin.js"
import type { AccessProviderDefinition } from "../../../infra/llm/access/access-provider.js"
import { moduleServiceHandle } from "../../../infra/module-service.js"
import { RouteUnavailableError } from "../../agent-runtime/llm/errors.js"
import type { AccessProviderFactory } from "../../agent-runtime/llm/routing/client-factory.js"
import type { ModuleServiceInstance, PortableModuleServices } from "../../app-service/executor/execution/module-service-host.js"
import type { FirstPartyModule } from "../../module-catalog.js"
import { antigravityDynamicCatalog } from "./catalog/catalog.js"
import type { EngineLaunchOptions, EngineProcess } from "./engine/engine-process.js"
import { antigravityEngineHost, currentEngineRuntime, openEngineRuntime } from "./engine/engine-runtime.js"
import { releaseLiveEngines } from "./engine/live-engines.js"
import { loginGateHook } from "./engine/login-gate.js"
import { antigravityLoginHealth, createLoginObservations } from "./login/login-status.js"
import { antigravityLogins, googleAntigravityLogin } from "./login/login.js"
import { GOOGLE_ANTIGRAVITY_CLI_FLAG, GOOGLE_ANTIGRAVITY_LABEL, GOOGLE_ANTIGRAVITY_LOGIN_COMMAND, GOOGLE_ANTIGRAVITY_MODULE_ID, GOOGLE_ANTIGRAVITY_PROVIDER_ID } from "./names.js"

/** What a test replaces. Production uses none of them. */
export interface GoogleAntigravitySeams {
  /** Launches one engine process in place of `launchEngine`; tests give one that starts no process. */
  readonly launchEngine?: (options: EngineLaunchOptions) => Promise<EngineProcess>
  /** The engine that logins and logouts run, in place of the one that ships with Flywheel; tests name a fake. */
  readonly enginePath?: () => string
}

/** What this process observed about the logins, which every login, request, and auth view of the process shares. */
const observations = createLoginObservations()

/** Runs `work` once no engine of this process runs on the login directory, and lets none start there until it
 *  settled (`EngineRegistry.withLoginReleased`). With no engine runtime in this process, no engine of it can run on
 *  the login, so `work` runs at once. */
function withLoginReleased<T>(loginDir: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  return currentEngineRuntime()?.registry.withLoginReleased(loginDir, signal, work) ?? work()
}

/** agy owns the login: it runs Google's sign-in, stores the token in the login's private home, and refreshes it.
 *  Each login is a directory in one auth profile, which Flywheel's login creates and its logout removes after agy's
 *  own logout. The plan includes its use, so there are no paid modes and no usage windows. One request never moves
 *  between Antigravity accounts (`accountRotation: "never"`, PI-MODEL-094): a chat tree stays on the account whose
 *  engine serves it, and a failure moves the request to another provider. Rank 5 puts it below Anthropic
 *  Subscription and above every other route that serves Gemini models, so the included plan serves first. */
function providerDefinition(seams: GoogleAntigravitySeams) {
  return {
    id: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
    displayName: GOOGLE_ANTIGRAVITY_LABEL,
    shortName: "Antigravity",
    defaultChatTransport: "google",
    configHints: [GOOGLE_ANTIGRAVITY_LOGIN_COMMAND],
    cli: { flag: GOOGLE_ANTIGRAVITY_CLI_FLAG, name: GOOGLE_ANTIGRAVITY_LABEL },
    billing: "subscription",
    rank: 5,
    catalogId: undefined,
    dynamicCatalog: antigravityDynamicCatalog(),
    accountRotation: "never",
    preferredAccount: (treeRootSessionId) => currentEngineRuntime()?.registry.preferredAccount(treeRootSessionId),
    auth: {
      ...googleAntigravityLogin(observations, (authDir) => ({
        authDir, host: antigravityEngineHost(), gateHook: loginGateHook, withLoginReleased, ...seams.enginePath === undefined ? {} : { enginePath: seams.enginePath },
      })),
      statusRank: 55,
    },
  } as const satisfies AccessProviderDefinition
}

const googleAntigravityService = moduleServiceHandle<ModuleServiceInstance>(GOOGLE_ANTIGRAVITY_MODULE_ID)

/**
 * The module's process service: this process's engine runtime (the engine registry, the tool listener, and the
 * login gates), launched on the service's launcher. Turning the module off ends its effect (ARCH-STRUCTURE-026)
 * without cancelling admitted work (ARCH-RUNTIME-063): every live engine use lets its engine go, at once when idle
 * and as soon as its open prompt settles otherwise. Only the service's end at the process's shutdown closes every
 * engine at once.
 */
function createGoogleAntigravityService(services: Pick<PortableModuleServices, "enabled" | "onSelectionChanged" | "launcher">, seams: GoogleAntigravitySeams): ModuleServiceInstance {
  const runtime = openEngineRuntime({ launcher: services.launcher, ...seams.launchEngine === undefined ? {} : { launch: seams.launchEngine } })
  const stop = services.onSelectionChanged(() => {
    if (!services.enabled()) releaseLiveEngines()
  })
  return {
    dispose: async () => {
      await stop()
      await runtime.dispose()
    },
  }
}

/** The client of one candidate, on its login directory and this process's engine runtime. The client, its bridge,
 *  and the MCP SDK load only when the first client is built. */
const createClient: AccessProviderFactory = async (build) => {
  const runtime = currentEngineRuntime()
  if (runtime === undefined) throw new RouteUnavailableError(`The ${GOOGLE_ANTIGRAVITY_LABEL} engines do not run in this process.`)
  const [{ createAntigravityClient }, { credentialForCandidate }] = await Promise.all([import("./client.js"), import("../../agent-runtime/llm/routing/client-factory.js")])
  const credential = credentialForCandidate(build.connection, build.candidate)
  if (credential?.type !== "external") throw new RouteUnavailableError(`The ${GOOGLE_ANTIGRAVITY_LABEL} provider requires a Google Antigravity login`)
  return createAntigravityClient(build, { registry: runtime.registry, loginDir: () => credential.configDir, gate: (loginDir) => runtime.gate(loginDir), observations })
}

/**
 * The Google Antigravity provider: Gemini models on the person's Antigravity plan, where every model request goes
 * through the unmodified `agy acp` engine that ships with Flywheel (ARCH-PROVIDERS-086). It is on by default and
 * offers no model until a login lists the models that agy offers it. `seams` exist for tests only.
 */
export function createGoogleAntigravityModule(seams: GoogleAntigravitySeams = {}) {
  const definition = providerDefinition(seams)
  return {
    id: GOOGLE_ANTIGRAVITY_MODULE_ID,
    dependencies: [],
    service: { handle: googleAntigravityService, portable: true, create: (services: PortableModuleServices) => createGoogleAntigravityService(services, seams) },
    contributions: [
      { domain: "providers", id: definition.id, value: { definition, createClient } },
      { domain: "health", id: GOOGLE_ANTIGRAVITY_MODULE_ID, value: {
        title: definition.displayName,
        check: (host) => antigravityLoginHealth(antigravityLogins(host.authDirectory()), observations, { enginePath: () => antigravityEnginePath(), pinned: pinnedAntigravityBytes() }),
      } },
      { domain: "settings", id: GOOGLE_ANTIGRAVITY_MODULE_ID, value: {
        control: "binary", group: "Model providers", label: definition.displayName,
        description: "Gemini through its bundled engine, with a login for each profile",
      } },
    ],
  } as const satisfies FirstPartyModule
}

export const googleAntigravityModule = createGoogleAntigravityModule()
