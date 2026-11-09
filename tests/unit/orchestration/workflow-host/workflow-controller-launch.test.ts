import { afterEach, describe, it, expect, mock, spyOn } from "bun:test"
import { DebugLog } from "../../../../src/infra/debug-log"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createDefinitionAvailability } from "../../../../src/orchestration/app-service/definition-availability.js"
import { fileTemporaryDirectory, testDirectories } from "../../../helpers/directories.js"
import { fullAuthority } from "../../../helpers/launch-authority.js"
import { repoModules } from "../../../helpers/project-definitions.js"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWorkflowController, type WorkflowControllerDeps } from "../../../../src/orchestration/workflow-host/controller"
import { MODULE_IDS } from "../../../../src/protocol/module-ids.js"
import { plannedCapabilities, planPromptRequest, type PromptAssembly } from "../../../../scripts/prompt-assembly.js"
import { capabilityAccessFor, type CapabilityAccess } from "../../../../src/orchestration/agent-runtime/tools/types.js"
import { loadConfig } from "../../../../src/orchestration/config/loader.js"
import { composeFirstPartyModules, unattendedModuleIds } from "../../../../src/orchestration/modules.js"
import { installedPersonaToolEntries } from "../../../../src/orchestration/tool-catalog.js"
import { createProjectDefinitionRegistry } from "../../../../src/workflows/definition-registry.js"
import {
  cleanupProjectRoots,
  createDeps,
  createMockManager,
  launchingController,
  makeWorkflowDeps,
  modelLaunch,
  fixtureSource,
  seedWorkflowRequest,
  until,
} from "./_workflow-controller-fixtures"
import { captureRuntimeConfigRequest } from "../../../../src/orchestration/agent-runtime/request-config"
import { CONFIG_DEFAULTS } from "../../../../src/orchestration/config/schema"
import type { AgentOptions, AgentPurpose } from "../../../../src/orchestration/agent-runtime/types"
import { createMockWorkflowHosts } from "./_workflow-host-fixtures"
import { installedDefinitionBundles, workflowRunOwner, workflowRunReader } from "../../../../src/orchestration/module-catalog"
import type { WorkflowResult } from "../../../../src/orchestration/workflow-host/runner-types"
import { terminalWorkflowFacts } from "../session/_child-session-reconciliation-fixtures"
import { WHOLE_WORKFLOW } from "../../../../src/orchestration/session/conversation/addressed-workflow-messages.js"

afterEach(() => {
  cleanupProjectRoots()
})

/** The capability check of one request of `purpose` under `access`, planned as a live request plans it over the
 *  installed definitions. */
async function plannedCapabilitiesUnder(root: string, purpose: AgentPurpose, access: CapabilityAccess) {
  const definitions = createProjectDefinitionRegistry({ projectRoot: root, userDataRoot: root, accountHome: root, skillRoots: [], bundles: installedDefinitionBundles(), personaToolEntries: installedPersonaToolEntries() }).captureRevision()
  const loaded = loadConfig(undefined, {}, root)
  const modules = composeFirstPartyModules()
  const assembly: PromptAssembly = {
    projectRoot: root, userDataRoot: root, accountHome: root, scratchDir: join(root, "scratch"), definitions,
    runtimeConfig: captureRuntimeConfigRequest({ revision: 0, config: loaded.config, warnings: loaded.warnings, diagnostics: loaded.diagnostics, sourceIdentity: "workflow-launch-boundary", status: { kind: "missing" } }, "default"),
    capture: modules, live: modules, workflowsMode: "off", servingModel: { model: "prompt-model", modelFamily: "anthropic" }, hosts: false,
  }
  return plannedCapabilities(await planPromptRequest(assembly, { personas: definitions.personas, purpose, askUser: false, capabilityAccess: access }))
}

describe("WorkflowController", () => {
  describe("startWorkflow", () => {
    it("publishes a workflow aggregate without creating a workflow session", async () => {
      const deps = createDeps()
      const controller = launchingController(deps)

      const result = await controller.startWorkflow({ source: fixtureSource(deps), description: "My task", origin: await modelLaunch(deps) })

      if ("error" in result) throw new Error(result.error)
      expect(await deps.manager.read(result.workflowId)).toBeNull()
      expect(await workflowRunReader(deps.projectionReader).read(result.workflowId)).toMatchObject({ name: "My task", workflowDefinitionId: "repair" })
      expect(deps.manager.publishWorkflow).toHaveBeenCalledTimes(1)
    })

    it("passes the exact admitted definition revision to the launched runner", async () => {
      const workflowHosts = createMockWorkflowHosts()
      const deps = createDeps({ workflowHosts })
      const admitted = deps.availability.capture().snapshot.definitionRevision
      const controller = launchingController(deps)

      const result = await controller.startWorkflow({ source: fixtureSource(deps), description: "Pinned launch", origin: await modelLaunch(deps) })

      if ("error" in result) throw new Error(result.error)
      await until(() => workflowHosts._startCalls.length > 0, "the workflow start")
      expect(workflowHosts._startCalls[0]?.workflowDeps.definitionRevision).toBe(admitted)
    })

    it("persists the durable profile while serving through an environment override", async () => {
      const manager = createMockManager()
      const publishedProfiles: Array<string | undefined> = []
      const publish = manager.publishWorkflow
      manager.publishWorkflow = async (input) => {
        publishedProfiles.push(input.authProfileId)
        return publish(input)
      }
      const preparedProfiles: Array<string | undefined> = []
      const deps = createDeps({
        manager,
        authProfiles: { inspect: () => ({
          retirements: {},
          id: "environment-profile",
          persistedId: "saved-profile",
          displayName: "Environment",
          source: "environment" as const,
          directory: join(tmpdir(), "environment-profile"),
          availableProfiles: [
            { id: "environment-profile", displayName: "Environment" },
            { id: "saved-profile", displayName: "Saved" },
          ],
          projectBinding: undefined,
        }) },
        prepareWorkflowDeps: async (profileId) => {
          preparedProfiles.push(profileId)
          return { ...makeWorkflowDeps(), activeProfileId: profileId }
        },
      })
      const controller = launchingController(deps)

      const result = await controller.startWorkflow({ source: fixtureSource(deps), description: "Capture profile", origin: await modelLaunch(deps) })

      expect("error" in result).toBe(false)
      expect(preparedProfiles).toEqual(["environment-profile"])
      expect(publishedProfiles).toEqual(["saved-profile"])
    })

    it("inherits the durable parent chat profile instead of the project default", async () => {
      const manager = createMockManager()
      await manager.createChat({ id: "parent-chat", conversationId: "parent-conversation", executionCwd: tmpdir(), authProfileId: "chatgpt-profile" })
      const preparedProfiles: Array<string | undefined> = []
      const deps = createDeps({
        manager,
        authProfiles: { inspect: () => ({
          retirements: {},
          id: "project-profile",
          persistedId: "project-profile",
          displayName: "Project",
          source: "project" as const,
          directory: join(tmpdir(), "project-profile"),
          availableProfiles: [
            { id: "project-profile", displayName: "Project" },
            { id: "chatgpt-profile", displayName: "ChatGPT" },
          ],
          projectBinding: "project-profile",
        }) },
        prepareWorkflowDeps: async (profileId) => {
          preparedProfiles.push(profileId)
          return { ...makeWorkflowDeps(), activeProfileId: profileId }
        },
      })
      const controller = launchingController(deps)

      const result = await controller.startWorkflow({
        source: fixtureSource(deps),
        description: "Use the parent account",
        origin: await modelLaunch(deps),
      })

      if ("error" in result) throw new Error(result.error)
      expect(preparedProfiles).toEqual(["chatgpt-profile"])
    })

    it("uses a workflow session profile change on its next provider request", async () => {
      const manager = createMockManager()
      const workflowHosts = createMockWorkflowHosts()
      let agentOptions: AgentOptions | undefined
      const preparedProfiles: Array<string | undefined> = []
      const controllerDeps = createDeps({
        manager,
        workflowHosts,
        authProfiles: { inspect: () => ({
          retirements: {},
          id: "work",
          persistedId: "work",
          displayName: "Work",
          source: "sticky" as const,
          directory: join(tmpdir(), "work"),
          availableProfiles: [
            { id: "work", displayName: "Work" },
            { id: "personal", displayName: "Personal" },
          ],
          projectBinding: undefined,
        }) },
        prepareWorkflowDeps: async (profileId) => {
          preparedProfiles.push(profileId)
          const base = makeWorkflowDeps()
          return {
            ...base,
            activeProfileId: profileId,
            createAgent: (options) => {
              agentOptions = options
              return base.createAgent(options)
            },
          }
        },
      })
      const controller = launchingController(controllerDeps)

      const result = await controller.startWorkflow({ source: fixtureSource(controllerDeps), description: "Live profile", origin: await modelLaunch(controllerDeps) })
      if ("error" in result) throw new Error(result.error)
      await until(() => workflowHosts._startCalls.length > 0, "the workflow start")
      const workflowDeps = workflowHosts._startCalls[0]?.workflowDeps
      if (!workflowDeps) throw new Error("workflow runtime was not started")
      workflowDeps.createAgent({
        model: "gpt-6.1-sol",
        purpose: { kind: "workflow-follow-up" },
        accountHome: workflowDeps.accountHome,
        userDataRoot: workflowDeps.userDataRoot,
        projectRoot: controllerDeps.projectRoot,
        executionCwd: tmpdir(),
        onEvent: () => {},
        conversation: { kind: "stateless" },
        lifecycle: { kind: "one-shot" },
      })
      const captureModelRuntime = agentOptions?.captureModelRuntime
      if (!captureModelRuntime) throw new Error("workflow agent requires request-time model admission")
      await captureModelRuntime()
      await workflowRunOwner().writer(controllerDeps.projectionReader, manager.commitWorkflow).update(result.workflowId, current => ({ ...current, authProfileId: "personal" }))
      await captureModelRuntime()

      expect(preparedProfiles).toEqual(["work", "personal"])
    })

    it("starts workflow workers in the directory the session recorded while project state stays with the project directory", async () => {
      const workflowHosts = createMockWorkflowHosts()
      const executionCwd = realpathSync(mkdtempSync(join(tmpdir(), "flywheel-controller-exec-")))
      const deps = createDeps({
        workflowHosts,
        manager: createMockManager({ executionCwd }),
        executionCwd,
        prepareWorkflowDeps: async () => makeWorkflowDeps(),
      })
      const controller = launchingController(deps)

      const origin = await modelLaunch(deps)
      const result = await controller.startWorkflow({ source: fixtureSource(deps), description: "Create a file", origin })

      if ("error" in result) throw new Error(result.error)
      await until(() => workflowHosts._startCalls.length > 0, "the workflow start")
      expect(workflowHosts._startCalls[0]?.executionCwd).toBe(executionCwd)
      expect(workflowHosts._startCalls[0]?.projectRoot).toBe(deps.projectRoot)
      expect(deps.projectRoot).not.toBe(executionCwd)
      rmSync(executionCwd, { recursive: true, force: true })
    })

    it("resolves a relative model override against the parent while project state stays unchanged", async () => {
      const parentCwd = realpathSync(mkdtempSync(join(tmpdir(), "flywheel-parent-exec-")))
      const childCwd = realpathSync(mkdtempSync(join(parentCwd, "child-")))
      const manager = createMockManager()
      await manager.createChat({ id: "parent-chat", conversationId: "parent-conversation", executionCwd: parentCwd })
      const workflowHosts = createMockWorkflowHosts()
      const deps = createDeps({ manager, workflowHosts })
      const controller = launchingController(deps)

      const result = await controller.startWorkflow({
        source: fixtureSource(deps),
        description: "Create a file",
        launchCwd: childCwd.slice(parentCwd.length + 1),
        origin: await modelLaunch(deps),
      })

      if ("error" in result) throw new Error(result.error)
      await until(() => workflowHosts._startCalls.length > 0, "the workflow start")
      expect((await workflowRunReader(deps.projectionReader).read(result.workflowId))?.executionCwd).toBe(childCwd)
      expect(workflowHosts._startCalls[0]?.executionCwd).toBe(childCwd)
      expect(workflowHosts._startCalls[0]?.projectRoot).toBe(deps.projectRoot)
      expect(deps.projectRoot).not.toBe(childCwd)
      rmSync(parentCwd, { recursive: true, force: true })
    })

    it("rejects an invalid model override before publication or runner creation", async () => {
      const parentCwd = realpathSync(mkdtempSync(join(tmpdir(), "flywheel-parent-exec-")))
      const manager = createMockManager()
      await manager.createChat({ id: "parent-chat", conversationId: "parent-conversation", executionCwd: parentCwd })
      const workflowHosts = createMockWorkflowHosts()
      const deps = createDeps({ manager, workflowHosts })
      const controller = launchingController(deps)

      const result = await controller.startWorkflow({
        source: fixtureSource(deps),
        description: "Create a file",
        launchCwd: "missing-directory",
        origin: await modelLaunch(deps),
      })

      expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining("does not exist") }))
      expect(manager.publishWorkflow).not.toHaveBeenCalled()
      expect(workflowHosts._startCalls).toEqual([])
      rmSync(parentCwd, { recursive: true, force: true })
    })

    it("starts with an exact catalog model identity", async () => {
      const workflowHosts = createMockWorkflowHosts()
      const manager = createMockManager()
      const deps = createDeps({
        workflowHosts,
        manager,
        prepareWorkflowDeps: async () => ({
          ...makeWorkflowDeps(),
          captureRuntimeConfig: () => captureRuntimeConfigRequest({
            revision: 0,
            config: { ...CONFIG_DEFAULTS, profiles: { default: { roles: { "workflow-agent": { model: "gpt-5.5", effort: "low" } }, git_ai_attribution: false, allow_training_routes: false, providers: {} } } },
            warnings: [],
            diagnostics: [],
            sourceIdentity: "test",
            status: { kind: "valid" },
          }, "default"),
        }),
      })
      const controller = launchingController(deps)

      const result = await controller.startWorkflow({ source: fixtureSource(deps), description: "Create a file", origin: await modelLaunch(deps) })

      expect("workflowId" in result).toBe(true)
      await until(() => workflowHosts._startCalls.length > 0, "the workflow start")
      expect(workflowHosts._startCalls).toHaveLength(1)
      expect(manager.publishWorkflow).toHaveBeenCalledTimes(1)
    })

    it("registers the launch summary as the run's name", async () => {
      const deps = createDeps({ prepareWorkflowDeps: async () => makeWorkflowDeps() })
      const result = await createWorkflowController(deps).startWorkflow({ source: fixtureSource(deps), summary: "Parser fix", description: "Fix the parser and its tests", origin: await modelLaunch(deps) })
      if ("error" in result) throw new Error(result.error)

      expect(await workflowRunReader(deps.projectionReader).read(result.workflowId)).toMatchObject({ label: "Parser fix", shortLabel: "Parser fix", name: "Parser fix" })
    })

    it("records a generated workflow name that the manager refuses at WARN, never as an unhandled rejection", async () => {
      const workflowHosts = createMockWorkflowHosts()
      const manager = createMockManager()
      const commit = manager.commitWorkflow
      manager.commitWorkflow = async (input) => {
        if (input.events.some(({ type }) => type === "workflow.run.settings.updated")) throw new Error("label write refused")
        return commit(input)
      }
      const deps = createDeps({ workflowHosts, manager, prepareWorkflowDeps: async () => makeWorkflowDeps() })
      const controller = createWorkflowController(deps)
      const result = await controller.startWorkflow({ source: fixtureSource(deps), description: "Name me", origin: await modelLaunch(deps) })
      if ("error" in result) throw new Error(result.error)
      const launch = workflowHosts._startCalls[0]
      if (!launch?.onSessionName) throw new Error("Missing name callback")
      spyOn(DebugLog, "isOpen").mockReturnValue(true)
      const record = spyOn(DebugLog, "record").mockImplementation(() => {})
      try {
        launch.onSessionName({ label: "Generated", shortLabel: "Gen" })
        // bun test fails the running test on an unhandled rejection.
        await Bun.sleep(0)

        // Other services of this process, such as the launch cells of earlier
        // cases, can report a coalesced warning while this case waits.
        const controllerRecords = record.mock.calls.map(([input]) => input).filter((input) => (input.type === "log.warn" || input.type === "log.error") && typeof input.payload === "object" && input.payload !== null && "service" in input.payload && input.payload.service === "workflow-controller")
        expect(controllerRecords).toEqual([
          expect.objectContaining({ type: "log.warn", payload: expect.objectContaining({ workflowId: result.workflowId, error: "label write refused" }) }),
        ])
      } finally {
        mock.restore()
      }
    })

    it("refuses model input that the workflow cannot take with the located reason, and publishes nothing", async () => {
      const workflowHosts = createMockWorkflowHosts()
      const manager = createMockManager()
      const deps = createDeps({ workflowHosts, manager, prepareWorkflowDeps: async () => makeWorkflowDeps() })
      const result = await createWorkflowController(deps).startWorkflow({ source: fixtureSource(deps), description: "Fan out", input: { targets: ["a"] }, origin: await modelLaunch(deps) })

      expect(result).toMatchObject({ error: 'Workflow "repair" declares no input contract, so it takes no input. Launch it again without input, and put the details in the description.' })
      expect(manager.publishWorkflow).not.toHaveBeenCalled()
      expect(workflowHosts.start).not.toHaveBeenCalled()
    })

    it("keeps a paused workflow call pending and settles terminal work through its parent once", async () => {
      const workflowHosts = createMockWorkflowHosts()
      let terminalChildSessionId: string | undefined = undefined
      const reconcile = mock(async (_parentSessionId: string) => ({
        reconciledCount: terminalChildSessionId ? 1 : 0,
        workflowAggregateReads: 1,
        durableTerminalChildSessionIds: terminalChildSessionId ? [terminalChildSessionId] : [],
      }))
      const deps = createDeps({
        workflowHosts,
        reconcileChildSessionCompletions: reconcile,
      })
      const controller = createWorkflowController(deps)
      const result = await controller.startWorkflow({
        source: fixtureSource(deps),
        description: "Return this work",
        origin: await modelLaunch(deps),
      })
      if ("error" in result) throw new Error(result.error)
      const start = workflowHosts._startCalls[0]
      if (!start?.onCoreCompleted || !start.onRunnerDone) throw new Error("workflow callbacks were not installed")
      const paused: WorkflowResult = { completed: false, attemptsCompleted: 1, attemptsTotal: 2, reason: "Paused", cost: 1, tokens: 10 }

      await start.onCoreCompleted(result.workflowId, paused)
      await start.onRunnerDone(result.workflowId, paused)

      expect(reconcile).toHaveBeenCalledTimes(2)
      expect(reconcile).toHaveBeenNthCalledWith(1, result.parentSessionId)
      expect(await Promise.race([result.done.then(() => "settled"), Bun.sleep(0).then(() => "pending")])).toBe("pending")

      const terminalFacts = terminalWorkflowFacts("Return this work", "completed")
      const aggregateSeq = await deps.projectionReader.aggregateSeq(`workflow:${result.workflowId}`) + terminalFacts.length
      await deps.eventWriter.appendBatch(terminalFacts.map((fact) => ({
        ...fact, ...(fact.type === "workflow.control.initialized" ? { payload: { control: { ...fact.payload.control, aggregateSeq } } } : {}),
        aggregateId: `workflow:${result.workflowId}`, sessionId: result.workflowId, timestamp: 1,
      })))
      terminalChildSessionId = result.workflowId
      const completed: WorkflowResult = { completed: true, attemptsCompleted: 2, attemptsTotal: 2, cost: 2, tokens: 20 }
      await start.onCoreCompleted(result.workflowId, completed)
      await start.onRunnerDone(result.workflowId, completed)
      workflowHosts._runners.delete(result.workflowId)

      expect(await result.done).toMatchObject({ status: "completed", usage: { totalTokens: 20, toolUses: 2 } })
      expect(reconcile).toHaveBeenCalledTimes(3)
      expect(reconcile).toHaveBeenLastCalledWith(result.parentSessionId)

      await expect(controller.resumeWorkflow(result.workflowId)).resolves.toEqual({
        kind: "terminal",
        message: "This workflow has finished and is read-only. Continue in its parent chat.",
      })
      await expect(controller.sendWorkflow(result.workflowId, "continue here")).resolves.toEqual({
        kind: "resume_failed",
        sessionId: result.workflowId,
        message: "This workflow has finished and is read-only. Continue in its parent chat.",
      })
    })

    it("pins the admitted capability composition while later launches see a disable", async () => {
      const workflowHosts = createMockWorkflowHosts()
      let selected = [...MODULE_IDS]
      const capabilities = {
        state: () => ({ capabilities: selected, moduleIds: selected, requireWorkflowConfirmation: false, workflowsMode: "on" as const, identity: selected.join("+") }),
        admit: async (request: { operation: string; required: readonly (typeof MODULE_IDS)[number][] }) => {
          const missing = request.required.filter((capability) => !selected.includes(capability))
          return missing.length > 0
            ? { ok: false as const, missing, reason: `${request.operation} is unavailable` }
            : {
                ok: true as const,
                grant: {
                  operation: request.operation,
                  required: request.required,
                  capabilities: selected,
                  moduleIds: selected,
                  requireWorkflowConfirmation: false,
                  workflowsMode: "on" as const,
                  identity: selected.join("+"),
                },
              }
        },
      }
      const deps = createDeps({
        capabilities,
        workflowHosts,
        prepareWorkflowDeps: async () => {
          selected = []
          return makeWorkflowDeps()
        },
      })
      const controller = launchingController(deps)

      const admitted = await controller.startWorkflow({ source: fixtureSource(deps), description: "Pinned run", origin: await modelLaunch(deps) })

      if ("error" in admitted) throw new Error(admitted.error)
      await until(() => workflowHosts._startCalls.length > 0, "the workflow start")
      const composition = workflowHosts._startCalls[0]?.workflowDeps.moduleSelection()
      if (!composition) throw new Error("expected workflow deps")
      expect(composition.observers.length).toBeGreaterThan(0)
      expect(composition.contributions).toEqual(expect.arrayContaining([
        expect.objectContaining({ domain: "tools", id: "skill" }),
        expect.objectContaining({ domain: "promptRosters", id: "skills" }),
      ]))
      await expect(controller.startWorkflow({ source: fixtureSource(deps), description: "Refused run", origin: await modelLaunch(deps) })).resolves.toEqual({ error: "the workflow file scratch/workflows/repair.workflow.yaml is unavailable" })
      expect(workflowHosts._startCalls).toHaveLength(1)
    })

    // A workflow is part of the tree of the chat that launched it, so its agents hold no capability that the chat's
    // boundary leaves out: under an unattended chat, no question for a person and no method that a person answers.
    // The run records that boundary, so every later start of it keeps it: a Resume, the continuation of a capacity
    // wait, and a person's Restart.
    it("bounds the workflow's agents and their subagents by the launching chat's capability boundary in every start of the run", async () => {
      const surfaceOf = async (projectRoot: string, access: CapabilityAccess | undefined) => {
        if (!access) throw new Error("expected the workflow's capability boundary")
        const agent = await plannedCapabilitiesUnder(projectRoot, { kind: "workflow-agent", briefScope: { briefId: "repair" }, workflowAttemptId: "attempt-1" }, access)
        const subagent = await plannedCapabilitiesUnder(projectRoot, { kind: "subagent", renderAs: "subagent", parentToolUseId: "dispatch" }, access)
        return { askUser: access.available("ask-user"), agentDesign: agent("skill:design"), subagentDesign: subagent("skill:design"), agentSkills: agent("skill:verification") }
      }
      const surfacesUnder = async (launcher: (capabilities: WorkflowControllerDeps["capabilities"]) => CapabilityAccess) => {
        const workflowHosts = createMockWorkflowHosts()
        const deps = createDeps({ workflowHosts })
        const controller = launchingController(deps)
        const origin = { ...await modelLaunch(deps), capabilityAccess: launcher(deps.capabilities) }
        const result = await controller.startWorkflow({ source: fixtureSource(deps), description: "Bounded run", origin })
        if ("error" in result) throw new Error(result.error)
        await until(() => workflowHosts._startCalls.length > 0, "the workflow start")
        const { workflowId } = result
        workflowHosts._runners.delete(workflowId)
        expect(await controller.resumeWorkflow(workflowId)).toEqual({ kind: "resumed", sessionId: workflowId })
        workflowHosts._runners.delete(workflowId)
        expect(await controller.resumeWorkflow(workflowId, WHOLE_WORKFLOW, { wake: { capacity: new Set(["waiting"]) } })).toEqual({ kind: "resumed", sessionId: workflowId })
        workflowHosts._runners.delete(workflowId)
        // A companion that this version cannot read is the damage a person's Restart repairs.
        await deps.eventWriter.append({ aggregateId: `workflow:${workflowId}`, sessionId: workflowId, timestamp: 2, type: "queue.created", version: 99, actor: "flywheel", payload: {} })
        expect(await controller.restartWorkflow(workflowId)).toEqual({ kind: "restarted", sessionId: workflowId })
        expect(workflowHosts._startCalls.map(({ startMode }) => startMode)).toEqual(["launch", "operator_resume", "operator_resume", "operator_resume"])
        return await Promise.all(workflowHosts._startCalls.map(({ workflowDeps }) => surfaceOf(deps.projectRoot, workflowDeps.capabilityAccess)))
      }

      const attended = { askUser: true, agentDesign: true, subagentDesign: true, agentSkills: true }
      const unattended = { askUser: false, agentDesign: false, subagentDesign: false, agentSkills: true }
      expect(await surfacesUnder((capabilities) => capabilityAccessFor(capabilities))).toEqual([attended, attended, attended, attended])
      expect(await surfacesUnder((capabilities) => capabilityAccessFor(capabilities, undefined, unattendedModuleIds(), true))).toEqual([unattended, unattended, unattended, unattended])
    })

    // A run recorded before the launch recorded its boundary, like a run a person's launch records now, holds no
    // boundary, so its Resume starts with the workflow's grant alone, as it did before.
    it("resumes a run recorded without a capability boundary under the workflow's grant alone", async () => {
      const workflowHosts = createMockWorkflowHosts()
      const deps = createDeps({ workflowHosts })
      await seedWorkflowRequest(deps, "wf-unbounded", "Unbounded run")

      expect(await createWorkflowController(deps).resumeWorkflow("wf-unbounded")).toEqual({ kind: "resumed", sessionId: "wf-unbounded" })

      const access = workflowHosts._startCalls[0]?.workflowDeps.capabilityAccess
      expect(access?.unattended).toBeUndefined()
      expect(access?.available("ask-user")).toBe(true)
    })
  })

  // No person reads an unattended chat's tree, so no agent of a workflow it launches may compose a method that a person
  // answers or approves, whether its brief names the method or a skill that composes it (PI-AGENT-121). Admission
  // refuses the launch and every later start of the run; a chat that a person reads launches the same workflow.
  describe("attended skills in an unattended run", () => {
    const repair = readFileSync(join(import.meta.dir, "../../../fixtures/workflow-project/workflows/repair.yaml"), "utf8")
    const composing = (skill: string) => repair.replace("dependencies: [root-cause-analysis]", `dependencies: [${skill}]`)
    const refusal = 'the agent "investigate" composes the skill "design", which a person answers or approves, and no person reads this run'
    // The installed definitions plus one package that composes `design`.
    const skillRoot = fileTemporaryDirectory("flywheel-attended-composition-")
    mkdirSync(join(skillRoot, "design-review"))
    writeFileSync(join(skillRoot, "design-review", "SKILL.md"), "---\ndescription: Use when reviewing a design.\ndependencies:\n  - design\n---\nReview the design.")
    // Project personas that require `design`, directly or through `design-review`.
    const personaDir = join(skillRoot, ".flywheel", "agents")
    mkdirSync(personaDir, { recursive: true })
    for (const [name, skill] of [["designer", "design"], ["design-reviewer", "design-review"]]) {
      writeFileSync(join(personaDir, `${name}.md`), `---\nname: ${name}\ndescription: Designs.\nrole: Designer.\nexcludeActions: []\nrequiredSkills:\n  - ${skill}\n---\nDesign the change.`)
    }
    const runningAs = (persona: string) => repair.replace("dependencies: [root-cause-analysis]", `dependencies: [root-cause-analysis]\n    persona: ${persona}`)
    const composingDefinitions = async () => {
      const definitions = createProjectDefinitionRegistry({ ...testDirectories(skillRoot), skillRoots: [{ dir: skillRoot, owned: true, reach: "global" }], bundles: installedDefinitionBundles(), personaToolEntries: installedPersonaToolEntries() })
      const state = () => ({ capabilities: MODULE_IDS, moduleIds: MODULE_IDS, requireWorkflowConfirmation: false, workflowsMode: "on" as const, identity: MODULE_IDS.join("+") })
      return { definitions, availability: await createDefinitionAvailability({ definitions, modules: repoModules, capabilities: { state } }) }
    }

    it("refuses an unattended launch whose brief composes an attended skill, directly or through a skill that composes it", async () => {
      for (const skill of ["design", "design-review"]) {
        const workflowHosts = createMockWorkflowHosts()
        const deps = createDeps({ workflowHosts, ...await composingDefinitions() })
        const origin = { ...await modelLaunch(deps), capabilityAccess: capabilityAccessFor(deps.capabilities, undefined, unattendedModuleIds(), true) }

        const result = await launchingController(deps).startWorkflow({ source: fixtureSource(deps, "parent-chat", composing(skill)), description: "Design it", origin })

        expect(result).toEqual({ error: `the workflow file scratch/workflows/repair.workflow.yaml is unavailable: ${refusal}` })
        expect(deps.manager.publishWorkflow).not.toHaveBeenCalled()
        expect(workflowHosts._startCalls).toEqual([])
      }
    })

    it("launches the same workflow from a chat that a person reads", async () => {
      const deps = createDeps()

      const result = await launchingController(deps).startWorkflow({ source: fixtureSource(deps, "parent-chat", composing("design")), description: "Design it", origin: await modelLaunch(deps) })

      expect("workflowId" in result).toBe(true)
    })

    it("refuses an unattended launch whose agent runs as a persona that requires an attended skill, and launches it from a chat that a person reads", async () => {
      for (const persona of ["designer", "design-reviewer"]) {
        const workflowHosts = createMockWorkflowHosts()
        const deps = createDeps({ workflowHosts, ...await composingDefinitions() })
        const launch = async (capabilityAccess?: CapabilityAccess) => launchingController(deps).startWorkflow({
          source: fixtureSource(deps, "parent-chat", runningAs(persona)), description: "Design it", origin: { ...await modelLaunch(deps), authority: fullAuthority([persona]), ...(capabilityAccess ? { capabilityAccess } : {}) },
        })

        expect(await launch(capabilityAccessFor(deps.capabilities, undefined, unattendedModuleIds(), true))).toEqual({
          error: `the workflow file scratch/workflows/repair.workflow.yaml is unavailable: the agent "investigate" runs as the persona "${persona}", and the persona composes the skill "design", which a person answers or approves, and no person reads this run`,
        })
        expect(deps.manager.publishWorkflow).not.toHaveBeenCalled()
        expect(workflowHosts._startCalls).toEqual([])

        expect("workflowId" in await launch()).toBe(true)
      }
    })

    it("refuses to resume an unattended run whose definition composes an attended skill", async () => {
      const workflowHosts = createMockWorkflowHosts()
      const deps = createDeps({ workflowHosts })
      await seedWorkflowRequest(deps, "wf-unattended", "Unattended run", { content: composing("design"), capabilityBoundary: { unattended: true } })

      expect(await createWorkflowController(deps).resumeWorkflow("wf-unattended")).toEqual({ kind: "unavailable", message: `resuming the repair workflow is unavailable: ${refusal}` })
      expect(workflowHosts._startCalls).toEqual([])
    })
  })

})
