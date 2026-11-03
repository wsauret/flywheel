import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncGuardedEventWriter, type GuardedEventStoreAppend } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { prepareWorkflowLaunch, WorkflowInputRejectedError } from "../../../../src/orchestration/workflow-host/publish.js"
import { INPUT_GROUP, inputBranch, inputMapWorkflow, itemList, items } from "./_map-fixtures.js"
import type { WorkflowDefinition } from "../../../../src/workflows/workflow-schema.js"
import { createWorkflowContextStore } from "../../../../src/workflows/context-bundle/context-store.js"
import { parseWorkflowSessionFact } from "../../../../src/workflows/vm/session-facts.js"
import { cleanupProjectRoots, composeModules, createCapabilities, createFixtureLaunchPort, createMockSessionStore, fixtureSource, FULL_AVAILABILITY, launchingController, makeWorkflowDeps, noConversationRecall, until } from "../../orchestration/workflow-host/_workflow-controller-fixtures.js"
import { fullAuthority } from "../../../helpers/launch-authority.js"
import { modelWorkflowLaunchOrigin } from "../../../../src/orchestration/workflow-host/launch-origin.js"
import { workflowParentBinding } from "../../../helpers/workflow-parent.js"
import { fixtureDefinitions, FIXTURE_WORKFLOW_ID, workflowIn } from "../../../helpers/project-definitions.js"
import { testDirectories } from "../../../helpers/directories.js"
import { FILE, pathSetup } from "../../orchestration/workflow-host/_path-launch-fixtures.js"
import { createSessionAuthAdmission } from "../../../../src/orchestration/session/session-auth-profile.js"
import { createMockWorkflowHosts } from "../../orchestration/workflow-host/_workflow-host-fixtures.js"
import { createWorkflowAuthOwner } from "../../../../src/orchestration/workflow-host/auth-owner.js"
import { workflowRunOwner, workflowRunReader } from "../../../../src/orchestration/module-catalog.js"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  cleanupProjectRoots()
})

describe("workflow VM launch atomicity", () => {
  it("prepares canonical guardrails and publishes every launch authority in one guarded batch", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-vm-launch-"))
    roots.push(root)
    const store = createSqliteEventStore(resolveEventStoreDbFile(root))
    const batches: (readonly GuardedEventStoreAppend[])[] = []
    const base = asAsyncEventWriter(store)
    const writer: AsyncGuardedEventWriter = {
      ...base,
      appendBatchGuarded: async (events) => {
        batches.push(events)
        return base.appendBatchGuarded(events)
      },
    }
    const manager = createSessionManager({ projectRoot: root, executionCwd: root, store, writer })
    const baseDeps = makeWorkflowDeps()
    const deps = {
      ...baseDeps,
      captureRuntimeConfig: () => ({ ...baseDeps.captureRuntimeConfig(), workflow: { max_attempts: 73 } }),
    }

    const prepared = await prepareWorkflowLaunch({
      authProfileId: "default",
      workflow: workflowIn(deps.definitions.captureRevision(), FIXTURE_WORKFLOW_ID),
      description: "atomic launch",
      deps,
      definitionRevision: deps.definitions.captureRevision(),
      projectRoot: root,
    })
    const sessionId = manager.allocateId()
    const launchedFrom = await workflowParentBinding(manager, { workflowDefinitionId: prepared.workflowDefinitionId })
    batches.length = 0
    await manager.publishWorkflow({
      id: sessionId,
      description: prepared.description,
      workflowDefinitionId: prepared.workflowDefinitionId,
      initialRoles: prepared.initialRoles,
      facts: prepared.workflowFacts,
      launchedFrom,
    })

    const workflowEvents = store.read({ aggregateId: `workflow:${sessionId}` })
    const initializedEvent = workflowEvents.find(({ type }) => type === "workflow.control.initialized")
    if (!initializedEvent) throw new Error("Published workflow requires workflow.control.initialized")
    const initialized = parseWorkflowSessionFact({
      type: initializedEvent.type,
      version: initializedEvent.version,
      actor: initializedEvent.actor,
      payload: initializedEvent.payload,
    })
    if (initialized.type !== "workflow.control.initialized") throw new Error("Expected initialized workflow control fact")
    expect(initialized.payload.control.guardrails).toMatchObject({ maxAttempts: 73, maxMutationsPerAttempt: 3, maxInserts: 20 })
    expect(initialized.payload.control.aggregateSeq).toBe(workflowEvents.length)
    const seedIndex = workflowEvents.findIndex(({ type }) => type === "context.input.seeded")
    expect(seedIndex).toBeGreaterThan(workflowEvents.findIndex(({ type }) => type === "workflow.compiled"))
    expect(seedIndex).toBeLessThan(workflowEvents.findIndex(({ type }) => type === "workflow.control.initialized"))
    expect(workflowEvents[seedIndex]?.payload).toEqual({
      workflowDefinitionId: FIXTURE_WORKFLOW_ID,
      userRequest: "atomic launch",
    })
    const liveContext = createWorkflowContextStore({ sessionId, reader: asAsyncEventReadSurface(store) })
    expect(await liveContext.getContext()).toEqual({
      request: { original: "atomic launch", addenda: [] },
      priorHandoff: null,
      reads: [],
      earlierRounds: [],
      artifacts: [],
      exclusions: [],
    })
    await liveContext.dispose()
    expect(batches).toHaveLength(1)
    expect(batches[0]?.map(({ type }) => type)).toEqual(expect.arrayContaining([
      "workflow.run.registered",
      "definition.loaded",
      "definition.hash_recorded",
      "workflow.compiled",
      "workflow.control.initialized",
      "context.input.seeded",
      "queue.created",
    ]))
    expect(store.read({ aggregateId: `workflow:${sessionId}` }).map(({ type }) => type)).toEqual(["workflow.run.registered", ...prepared.workflowFacts.map(({ type }) => type)])
    expect(await manager.read(sessionId)).toBeNull()
    store.close()
  })

  it("resolves atomic initialization publication before production execution starts", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-vm-launch-order-"))
    roots.push(root)
    const store = createSqliteEventStore(resolveEventStoreDbFile(root))
    const base = asAsyncEventWriter(store)
    let publicationResolved = false
    const writer: AsyncGuardedEventWriter = {
      ...base,
      appendBatchGuarded: async (events) => {
        const stored = await base.appendBatchGuarded(events)
        publicationResolved = true
        return stored
      },
    }
    const manager = createSessionManager({ projectRoot: root, executionCwd: root, store, writer })
    const sessionStore = createMockSessionStore()
    const workflowHosts = createMockWorkflowHosts()
    const start = workflowHosts.start
    workflowHosts.start = async (options) => {
      expect(publicationResolved).toBe(true)
      expect(store.read({ aggregateId: `workflow:${options.sessionId}` }).some(({ type }) => type === "workflow.control.initialized")).toBe(true)
      return start(options)
    }
    const deps = makeWorkflowDeps()
    const directories = testDirectories(root)
    const reader = asAsyncEventReadSurface(store)
    const authProfiles = { inspect: () => ({ id: "default", persistedId: "default", displayName: "Default", source: "default" as const, directory: join(directories.userDataRoot, "auth", "profiles", "default"), availableProfiles: [{ id: "default", displayName: "Default" }], projectBinding: undefined, retirements: {} }) }
    const controller = launchingController({
      launchPort: createFixtureLaunchPort({ manager, reader: asAsyncEventReadSurface(store), writer }),
      sessionStore,
      workflowHosts,
      manager,
      definitions: fixtureDefinitions(),
      eventReader: asAsyncEventReadSurface(store),
      projectionReader: asAsyncEventReadSurface(store),
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
      workflowMode: () => "on",
      recall: noConversationRecall,
    })

    const parentSessionId = await manager.createChat({ name: "Parent" })
    const parent = await manager.read(parentSessionId)
    if (parent?.kind !== "chat") throw new Error("expected parent chat")
    const result = await controller.startWorkflow({ source: fixtureSource({ projectRoot: root }, parentSessionId), description: "ordered launch", origin: modelWorkflowLaunchOrigin(parentSessionId, { conversationId: parent.conversationId, toolUseId: "launch-call", confirmation: { kind: "absent" }, authority: fullAuthority() }) })

    expect("error" in result).toBe(false)
    await until(() => workflowHosts._startCalls.length > 0, "the workflow start")
    expect(workflowHosts._startCalls).toHaveLength(1)
    store.close()
  })

  it("refuses an invalid workflow file before any fact exists, with no child session and no runner", async () => {
    const setup = await pathSetup()
    const file = setup.write("broken.workflow.yaml", FILE.replace("    name: Survey\n", "    name: Survey\n    reads: [missing]\n"))
    const positions = setup.store.read({}).length

    const result = await setup.launch(file)

    if (!("error" in result)) throw new Error(`expected a refusal, got workflow ${result.workflowId}`)
    // The agent passed the absolute path; the refusal names the file by its
    // place in the session directory throughout.
    expect(result.error).toBe("the workflow file scratch/workflows/broken.workflow.yaml is unavailable: the file is not valid.")
    expect(result.problems).toEqual([
      'scratch/workflows/broken.workflow.yaml: Phase "survey", phases.0.reads: reads names "missing", which is no phase or agent of this workflow',
    ])
    expect(setup.store.read({}).length).toBe(positions)
    expect(setup.starts).toEqual([])
  })

  it("leaves metadata and workflow aggregates empty when the multi-aggregate append conflicts", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-vm-launch-conflict-"))
    roots.push(root)
    const store = createSqliteEventStore(resolveEventStoreDbFile(root))
    const deps = makeWorkflowDeps()
    const prepared = await prepareWorkflowLaunch({ workflow: workflowIn(deps.definitions.captureRevision(), FIXTURE_WORKFLOW_ID), description: "conflict", deps, authProfileId: "default", projectRoot: root, definitionRevision: deps.definitions.captureRevision() })
    const sessionId = "workflow-conflict"
    const base = asAsyncEventWriter(store)
    const writer: AsyncGuardedEventWriter = {
      ...base,
      appendBatchGuarded: async (events) => base.appendBatchGuarded(events.map((event) => ({
        ...event,
        ...(event.aggregateId === `workflow:${sessionId}` ? { expectedSeq: 1 } : {}),
      }))),
    }
    const manager = createSessionManager({ projectRoot: root, executionCwd: root, store, writer })
    const launchedFrom = await workflowParentBinding(manager, { workflowDefinitionId: prepared.workflowDefinitionId })

    await expect(manager.publishWorkflow({
      id: sessionId,
      description: prepared.description,
      workflowDefinitionId: prepared.workflowDefinitionId,
      initialRoles: prepared.initialRoles,
      facts: prepared.workflowFacts,
      launchedFrom,
    })).rejects.toThrow("Workflow destination changed before publication")

    expect(store.read({ aggregateId: `session:${sessionId}` })).toEqual([])
    expect(store.read({ aggregateId: `workflow:${sessionId}` })).toEqual([])
    store.close()
  })

  it("decodes structured input before any fact exists, records it once in the launch seed, and expands its map", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-vm-launch-input-"))
    roots.push(root)
    const deps = makeWorkflowDeps()
    const captured = deps.definitions.captureRevision()
    // A contract whose fields are all optional admits a launch without input.
    const optional: WorkflowDefinition = { ...inputMapWorkflow, id: "input-optional", input: { fields: { items: { ...itemList(3), optional: true } } } }
    const definitionRevision = captured
    const launch = (workflowDefinitionId: string, input: unknown) => prepareWorkflowLaunch({
      workflow: workflowDefinitionId === optional.id ? optional : workflowDefinitionId === inputMapWorkflow.id ? inputMapWorkflow : workflowIn(captured, workflowDefinitionId), description: "input launch", deps, authProfileId: "default", projectRoot: root, definitionRevision,
      ...(input === undefined ? {} : { input }),
    })

    const input = { goal: "Ship.", items: items("a", "b") }
    const prepared = await launch(inputMapWorkflow.id, input)
    const seeds = prepared.workflowFacts.filter(({ type }) => type === "context.input.seeded")
    expect(seeds).toEqual([{ type: "context.input.seeded", version: 2, actor: "flywheel", payload: { workflowDefinitionId: inputMapWorkflow.id, userRequest: "input launch", input } }])
    const initialized = prepared.workflowFacts.find(({ type }) => type === "workflow.control.initialized")
    if (initialized?.type !== "workflow.control.initialized") throw new Error("Expected workflow.control.initialized")
    expect(initialized.payload.control.graph.joins).toEqual([{ kind: "collect_all", nodeId: INPUT_GROUP, requiredNodeIds: [inputBranch(1), inputBranch(2)] }])

    // Each refusal names the key path at fault and how to correct it.
    const refusal = async (workflowDefinitionId: string, value: unknown): Promise<string> => {
      const error = await launch(workflowDefinitionId, value).then(() => null, (cause: unknown) => cause)
      if (!(error instanceof WorkflowInputRejectedError)) throw new Error(`Expected an input refusal, got ${String(error)}`)
      return error.message
    }
    expect(await refusal(FIXTURE_WORKFLOW_ID, { goal: "Ship." })).toMatch(/declares no input contract, so it takes no input\. Launch it again without input/)
    expect(await refusal(inputMapWorkflow.id, { items: items("a") })).toMatch(/- input\.goal: Missing key\nCorrect the input/)
    expect(await refusal(inputMapWorkflow.id, { goal: 7, items: items("a") })).toContain("- input.goal: Expected string\n")
    expect(await refusal(inputMapWorkflow.id, { goal: "Ship.", items: items("a", "b", "c", "d") })).toContain("- input.items: Expected a value with a length of at most 3")
    expect(await refusal(inputMapWorkflow.id, { goal: "Ship.", items: items("a", "a") })).toContain("- input.items: each item must have a different \"id\"")
    // A launch that passed no input, such as a person's slash launch, learns
    // that only an agent launch can pass it.
    expect(await refusal(inputMapWorkflow.id, undefined)).toMatch(/requires structured input, and this launch passed none:\n- input\.items: Missing key\n- input\.goal: Missing key\nOnly an agent launch can pass input/)

    // A launch without input of a contract that requires no field keeps the
    // version 1 seed bytes, and the map over the absent list has no branches.
    const bare = await launch(optional.id, undefined)
    expect(bare.workflowFacts.filter(({ type }) => type === "context.input.seeded"))
      .toEqual([{ type: "context.input.seeded", version: 1, actor: "flywheel", payload: { workflowDefinitionId: optional.id, userRequest: "input launch" } }])
    const bareControl = bare.workflowFacts.find(({ type }) => type === "workflow.control.initialized")
    if (bareControl?.type !== "workflow.control.initialized") throw new Error("Expected workflow.control.initialized")
    expect(bareControl.payload.control.graph.joins).toEqual([{ kind: "collect_all", nodeId: "input-optional:node:1", requiredNodeIds: [] }])
  })
})
