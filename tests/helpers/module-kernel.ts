import { asAsyncEventReadSurface } from "../../src/infra/substrate/store/event-store-types.js"
import { NO_MODULE_SERVICES } from "../../src/infra/definitions/modules/module-service.js"
import type { ModuleProcessServices, ProfileStateStore } from "../../src/orchestration/app-service/executor/execution/module-service-host.js"
import { composeFirstPartyModules } from "../../src/orchestration/module-contract/module-composition.js"
import type { SessionManager } from "../../src/orchestration/session/manager.js"
import type { SessionStore } from "../../src/orchestration/session-store/types.js"
import { testDirectories } from "./directories.js"
import { inMemoryEventReader } from "./in-memory-event-reader.js"
import { refusingLauncher } from "./launcher-fake.js"
import { refusingEventWriter } from "./event-writer-doubles.js"

/** The kernel authorities a module's process-scoped service receives, without
 *  the two that composition adds itself. */
type KernelPorts = Omit<ModuleProcessServices, "modules" | "enabled">

const refuse = (port: string) => (): never => {
  throw new Error(`this test provides no ${port}`)
}

/** A profile state store that holds nothing and refuses every write and listener. */
export function refusingProfileStore(): ProfileStateStore {
  return { dbFile: "/scratch/profile-state.sqlite", reader: asAsyncEventReadSurface(inMemoryEventReader([])), writer: refusingEventWriter(), onStored: refuse("profileStore.onStored") }
}

/** A session manager that refuses every call, for a kernel whose services never touch sessions. */
const refusingSessionManager: SessionManager = {
  allocateId: refuse("sessionManager.allocateId"),
  publishWorkflow: refuse("sessionManager.publishWorkflow"),
  commitWorkflow: refuse("sessionManager.commitWorkflow"),
  adoptWorkflow: refuse("sessionManager.adoptWorkflow"),
  publishSubagent: refuse("sessionManager.publishSubagent"),
  createChat: refuse("sessionManager.createChat"),
  forkChat: refuse("sessionManager.forkChat"),
  createChatFromContext: refuse("sessionManager.createChatFromContext"),
  listMetadata: refuse("sessionManager.listMetadata"),
  listActive: refuse("sessionManager.listActive"),
  listForIds: refuse("sessionManager.listForIds"),
  read: refuse("sessionManager.read"),
  updateLifecycleState: refuse("sessionManager.updateLifecycleState"),
  publishActivation: refuse("sessionManager.publishActivation"),
  updateLabel: refuse("sessionManager.updateLabel"),
  updateChatMetadata: refuse("sessionManager.updateChatMetadata"),
  captureRolesIfAbsent: refuse("sessionManager.captureRolesIfAbsent"),
  captureAuthProfileIfAbsent: refuse("sessionManager.captureAuthProfileIfAbsent"),
  selectAuthProfile: refuse("sessionManager.selectAuthProfile"),
  selectAuthProfileWithRoleSnapshot: refuse("sessionManager.selectAuthProfileWithRoleSnapshot"),
  replaceRoleSnapshot: refuse("sessionManager.replaceRoleSnapshot"),
  updateRoleAssignment: refuse("sessionManager.updateRoleAssignment"),
  removeRoleAssignment: refuse("sessionManager.removeRoleAssignment"),
  unlinkChild: refuse("sessionManager.unlinkChild"),
  admitDeletion: refuse("sessionManager.admitDeletion"),
  finalizeDeletionTarget: refuse("sessionManager.finalizeDeletionTarget"),
  recoverStaleSessions: refuse("sessionManager.recoverStaleSessions"),
  subscribe: refuse("sessionManager.subscribe"),
}

/** A session store that refuses every call, for a kernel whose services never touch runners. */
const refusingSessionStore: SessionStore = {
  openSessionRuntime: refuse("sessionStore.openSessionRuntime"),
  replaceChatDisplaySeed: refuse("sessionStore.replaceChatDisplaySeed"),
  attachChatRunner: refuse("sessionStore.attachChatRunner"),
  appendPreRunnerOutput: refuse("sessionStore.appendPreRunnerOutput"),
  showStartupFailure: refuse("sessionStore.showStartupFailure"),
  get: refuse("sessionStore.get"),
  has: refuse("sessionStore.has"),
  isRunning: refuse("sessionStore.isRunning"),
  abort: refuse("sessionStore.abort"),
  activeRunner: refuse("sessionStore.activeRunner"),
  remove: refuse("sessionStore.remove"),
  updateEntry: refuse("sessionStore.updateEntry"),
  updateChatEntry: refuse("sessionStore.updateChatEntry"),
  reorder: refuse("sessionStore.reorder"),
  runningCount: refuse("sessionStore.runningCount"),
  allIds: refuse("sessionStore.allIds"),
  revision: refuse("sessionStore.revision"),
  drainOutputChanges: refuse("sessionStore.drainOutputChanges"),
  disposeAll: refuse("sessionStore.disposeAll"),
  onChange: refuse("sessionStore.onChange"),
  refreshDeps: refuse("sessionStore.refreshDeps"),
}

/** Kernel authorities for a module service test. Every port that `provided`
 *  does not name refuses when called: listeners and lookups throw, the stores
 *  are empty, the launcher starts nothing, and the configuration is absent.
 *  The module selection is the installed catalog with nothing disabled.
 *  A test names only the ports its service reads, so a service that reaches
 *  past them fails by the port's name. The value is a plain object, because
 *  composition spreads it into each service's bag. */
export function kernelPorts(provided: Partial<KernelPorts> = {}): KernelPorts {
  const empty = asAsyncEventReadSurface(inMemoryEventReader([]))
  return {
    transports: { addListener: refuse("transports.addListener") },
    onFrontendEvent: refuse("onFrontendEvent"),
    profileAccounting: refuse("profileAccounting"),
    executionEnvironment: refuse("executionEnvironment"),
    configView: refuse("configView"),
    moduleSelection: composeFirstPartyModules,
    onSelectionChanged: refuse("onSelectionChanged"),
    notify: refuse("notify"),
    interactive: false,
    directories: testDirectories(process.cwd()),
    eventStore: empty,
    projectionReader: empty,
    eventWriter: refusingEventWriter(),
    onStored: refuse("onStored"),
    profileStore: refusingProfileStore(),
    authProfileId: refuse("authProfileId"),
    publish: refuse("publish"),
    snapshotPosition: refuse("snapshotPosition"),
    sessionManager: refusingSessionManager,
    sessionStore: refusingSessionStore,
    config: { snapshot: refuse("config.snapshot"), subscribe: refuse("config.subscribe"), mutateSection: refuse("config.mutateSection") },
    launcher: refusingLauncher,
    ...provided,
  }
}

/** The whole bag one module service receives: {@link kernelPorts} with no
 *  services built before it, and enabled unless `provided` says otherwise. */
export function moduleProcessServices(provided: Partial<ModuleProcessServices> = {}): ModuleProcessServices {
  return { ...kernelPorts(provided), modules: NO_MODULE_SERVICES, enabled: () => true, ...provided }
}
