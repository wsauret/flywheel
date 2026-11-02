import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile, resolveSessionDir } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { createMockWorkflowHosts } from "./_workflow-host-fixtures.js"
import type { WorkflowDeps } from "../../../../src/orchestration/workflow-host/deps.js"
import { createWorkflowToolCore, type PublishedWorkflowLaunch } from "../../../../src/orchestration/agent-runtime/tools/workflow-tool.js"
import type { WorkflowLaunchRefusal } from "../../../../src/orchestration/workflow-host/launch-origin.js"
import { modelWorkflowLaunchOrigin, workflowLaunchTargets } from "../../../../src/orchestration/workflow-host/launch-origin.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { createSessionAuthAdmission } from "../../../../src/orchestration/session/session-auth-profile.js"
import { createWorkflowAuthOwner } from "../../../../src/orchestration/workflow-host/auth-owner.js"
import { workflowRunOwner, workflowRunReader } from "../../../../src/orchestration/module-catalog.js"
import { sessionWorkflowsDir } from "../../../../src/orchestration/workflow-host/path-workflow.js"
import { testDirectories } from "../../../helpers/directories.js"
import { fullAuthority } from "../../../helpers/launch-authority.js"
import { fixtureDefinitions } from "../../../helpers/project-definitions.js"
import {
  composeModules,
  createCapabilities,
  createFixtureLaunchPort,
  createMockSessionStore,
  FULL_AVAILABILITY,
  launchingController,
  makeWorkflowDeps,
  noConversationRecall,
  trackEventStore,
  trackProjectRoot,
} from "./_workflow-controller-fixtures.js"

/** A self-contained workflow file that a chat agent could write. */
export const FILE = `id: survey-routes
name: Survey routes
description: Survey the routes.
phases:
  - phase: survey
    name: Survey
    brief: List every route in src/routes and report each one.
`

/** One controller over a real session manager and event store, with a parent
 *  chat whose scratch workflow directory exists. */
export async function pathSetup(mode: "on" | "ask" = "on", suppliedDeps?: WorkflowDeps) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flywheel-path-launch-")))
  trackProjectRoot(root)
  const store = trackEventStore(createSqliteEventStore(resolveEventStoreDbFile(root)))
  const reader = asAsyncEventReadSurface(store)
  const writer = asAsyncEventWriter(store)
  const manager = createSessionManager({ projectRoot: root, executionCwd: root, store })
  const chatSessionId = await manager.createChat({ name: "Parent" })
  const parent = await manager.read(chatSessionId)
  if (parent?.kind !== "chat") throw new Error("the parent is not a chat")
  const sessionDir = resolveSessionDir(chatSessionId, root)
  const dir = sessionWorkflowsDir(sessionDir)
  mkdirSync(dir, { recursive: true })
  const workflowHosts = createMockWorkflowHosts()
  const starts = workflowHosts._startCalls
  const sessionStore = createMockSessionStore()
  const deps = suppliedDeps ?? makeWorkflowDeps()
  const directories = testDirectories(root)
  const authProfiles = { inspect: () => ({ id: "default", persistedId: "default", displayName: "Default", source: "default" as const, directory: join(directories.userDataRoot, "auth", "profiles", "default"), availableProfiles: [{ id: "default", displayName: "Default" }], projectBinding: undefined, retirements: {} }) }
  const controller = launchingController({
    launchPort: createFixtureLaunchPort({ manager, reader, writer }),
    sessionStore,
    workflowHosts,
    manager,
    definitions: fixtureDefinitions(),
    eventReader: reader,
    projectionReader: reader,
    eventWriter: writer,
    authAdmission: createSessionAuthAdmission({
      materialize: async () => { throw new Error("unexpected retirement") },
      manager,
      authProfiles,
      workflows: createWorkflowAuthOwner({ reader: workflowRunReader(reader), writer: workflowRunOwner().writer(reader, manager.commitWorkflow), profiles: authProfiles, userDataRoot: directories.userDataRoot, onSelected: async () => {} }),
      prepare: async () => deps,
    }),
    ...directories,
    capabilities: createCapabilities(),
    composeModules,
    availability: FULL_AVAILABILITY,
    workflowMode: () => mode,
    recall: noConversationRecall,
  })
  const launch = (path: string, confirmationId?: string, input?: { readonly [key: string]: unknown }) => controller.startWorkflow({
    source: { kind: "path", path },
    description: "Survey the routes of the web server.",
    ...(input === undefined ? {} : { input }),
    origin: {
      kind: "model",
      chatSessionId,
      conversationId: parent.conversationId,
      toolUseId: `toolu-${starts.length}`,
      confirmation: confirmationId ? { kind: "supplied", confirmationId } : { kind: "absent" },
      authority: fullAuthority(),
    },
  })
  // The parent chat's `workflow` tool over the same controller, wired as the
  // session runtime wires it: the host stamps the trusted model origin.
  const launched: (PublishedWorkflowLaunch | WorkflowLaunchRefusal)[] = []
  const tool = createWorkflowToolCore({
    startWorkflow: async ({ model, ...intent }) => {
      const result = await controller.startWorkflow({ ...intent, origin: modelWorkflowLaunchOrigin(chatSessionId, model) })
      launched.push(result)
      return result
    },
    onRenderEvent: () => {},
    mode,
    resolveLaunchTarget: workflowLaunchTargets({ revision: () => fixtureDefinitions().captureRevision(), sessionDir, executionCwd: root }),
    askUserAvailable: true,
    authority: fullAuthority(),
    sessionDir,
    executionCwd: root,
  })
  /** One model call that passes the content of a workflow file, and what
   *  the controller answered it, when the call reached the controller. */
  const launchContent = async (content: string, confirmationId?: string) => {
    const before = launched.length
    const result = await tool.execute(
      { source: { kind: "content", content }, summary: "Survey", description: "Survey the routes of the web server.", ...(confirmationId ? { confirmation_id: confirmationId } : {}) },
      { toolUseId: `toolu-content-${before}`, conversationId: parent.conversationId },
    )
    return { result, launch: launched.length > before ? launched.at(-1) : undefined }
  }
  const write = (name: string, content: string): string => {
    const file = join(dir, name)
    writeFileSync(file, content)
    return file
  }
  return { root, store, manager, sessionStore, workflowHosts, controller, chatSessionId, conversationId: parent.conversationId, sessionDir, dir, starts, launch, launchContent, write }
}
