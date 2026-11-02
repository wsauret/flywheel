import type { ServeLane } from "../../infra/cli-subprocess.js"
import { errorMessage } from "../../infra/error-message.js"
import { startRefusalCopy } from "../../protocol/client/runtime-fault-copy.js"
import { startRefusalOf } from "../../protocol/serve-handshake.js"
import type { AccountProjectRegistry } from "./account-project-registry.js"
import type { AccountService, ProjectSlot } from "./account-service.js"
import type { ControlUiAssets, ControlUiAssetState } from "./web-serving/control-ui-assets.js"
import { startAccountHub, type AccountHubOptions, type AccountHubProject, type Hub } from "./web-serving/hub.js"
import { createHubMutationCredential } from "./web-serving/origin-check.js"
import { keepProjectAddresses, type ProjectAddressReading } from "./web-serving/project-addresses.js"

/** Whether an open project's browser endpoint serves, and at which link. */
export type ProjectBrowserState =
  | { readonly kind: "ready"; readonly link: string }
  | { readonly kind: "failed"; readonly error: string }

/** What the account's browser addresses read of one open project. */
interface BrowserProject {
  readonly browserState: ProjectBrowserState | undefined
  readonly openBrowser: () => Promise<string>
  readonly holdClient: () => () => void
  readonly dispose: () => Promise<void>
}

/** A failure whose cause the service named reads as the same words every
 *  client shows for it; any other reads as its own message. */
function projectOpenFailure(error: unknown): string {
  const refusal = startRefusalOf(error)
  if (refusal === undefined) return errorMessage(error)
  const copy = startRefusalCopy(refusal, "installed")
  return `${copy.title} ${copy.remedy}`
}

/** The hub's reading of one registered project. The composition slot decides
 *  asleep, starting, closing, open, or failed, and an open composition still reads as
 *  starting until the web client its link serves can be served: the hub
 *  redirects to that link, and a redirect before the client's files are
 *  located or built lands on the placeholder page instead of the client. */
export function hubProject(
  record: Awaited<ReturnType<AccountProjectRegistry["list"]>>[number],
  slot: ProjectSlot<Pick<BrowserProject, "browserState">> | undefined,
  assets: ControlUiAssetState,
): AccountHubProject {
  const project = { id: record.id, label: record.label, projectRoot: record.projectRoot }
  if (slot === undefined) return { ...project, state: "asleep" }
  if (slot.state === "opening") return { ...project, state: "starting" }
  if (slot.state === "closing") return { ...project, state: "closing" }
  if (slot.state === "failed") return { ...project, state: "failed", error: projectOpenFailure(slot.error) }
  const browser = slot.runtime.browserState
  if (browser?.kind === "failed") return { ...project, state: "unavailable", error: browser.error }
  if (assets.kind === "failed") return { ...project, state: "unavailable", error: assets.error }
  if (browser === undefined) return { ...project, state: "starting" }
  if (assets.kind === "preparing") return { ...project, state: "starting" }
  return { ...project, state: "open", link: browser.link }
}

/** A project's own address reads its slot: a slot that holds a runtime owns
 *  the address or is about to, and only a project that holds nothing leaves
 *  the address free for the service to answer at. */
function addressReading(slot: ProjectSlot<unknown> | undefined): ProjectAddressReading {
  if (slot === undefined) return { kind: "asleep" }
  if (slot.state === "failed" && slot.runtime === undefined) return { kind: "failed", error: projectOpenFailure(slot.error) }
  return { kind: "held" }
}

export interface AccountWebAddressOptions<Runtime extends BrowserProject> {
  readonly lane: ServeLane
  readonly service: AccountService<Runtime>
  readonly registry: Pick<AccountProjectRegistry, "list" | "forget">
  readonly assets: Pick<ControlUiAssets, "prepare" | "openable">
  readonly startHub?: (options: AccountHubOptions) => Hub
}

export interface AccountWebAddresses {
  /** Hands a project's own address to its endpoint, which binds it next. */
  readonly release: (projectRoot: string) => void
  /** Lets go of every address at once, so a successor can bind them. */
  readonly stop: () => void
}

/** Every browser address the account service answers at: the lane's fixed
 *  hub, which lists the known projects (PI-LOCAL-005), and each known
 *  project's own address while that project is not open (PI-LOCAL-002). */
export function startAccountWebAddresses<Runtime extends BrowserProject>(options: AccountWebAddressOptions<Runtime>): AccountWebAddresses {
  const { service, registry, assets } = options
  // The hub starts first, because a project's address links to the origin
  // the hub bound. A forget, which reads the addresses, comes from a request
  // to the hub, after both exist.
  const hub = (options.startHub ?? startAccountHub)({
    lane: options.lane,
    credential: createHubMutationCredential(),
    listProjects: async () => (await registry.list()).map((project) => hubProject(project, service.project(project.projectRoot), assets.prepare())),
    openProject: async (id) => {
      const project = (await registry.list()).find((candidate) => candidate.id === id)
      if (!project) throw new Error("Project is not registered")
      const runtime = await service.open(project.projectRoot)
      const release = runtime.holdClient()
      try {
        const link = await runtime.openBrowser()
        await assets.openable()
        return link
      } finally {
        release()
      }
    },
    forgetProject: async (id) => {
      const project = (await registry.list()).find((candidate) => candidate.id === id)
      if (!project) throw new Error("Project is not registered")
      await registry.forget(project.projectRoot)
      addresses.release(project.projectRoot)
    },
  })
  const addresses = keepProjectAddresses({
    listProjects: () => registry.list(),
    reading: (projectRoot) => addressReading(service.project(projectRoot)),
    watch: (listener) => service.watch((projectRoot) => { listener(projectRoot) }),
    // The open records its own failure, which the address then reads.
    wake: (projectRoot) => { void service.open(projectRoot, "browser").catch(() => {}) },
    hubOrigin: hub.origin,
  })
  return {
    release: addresses.release,
    stop: () => {
      hub.stop()
      addresses.stop()
    },
  }
}
