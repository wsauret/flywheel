import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, realpathSync, rmSync } from "node:fs"
import { join } from "node:path"
import { composeModules } from "../../../../src/infra/module-descriptor.js"
import { composeModuleRuntimes, moduleRuntimeHandle } from "../../../../src/infra/module-runtime.js"
import { createRuntimeSupervisor } from "../../../../src/orchestration/app-service/runtime-supervisor.js"
import { EventReaderService, EventStoreWriterService } from "../../../../src/infra/event-store-effect.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { loadSessionView } from "../../../../src/orchestration/session-store/view.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import type { RuntimeCommandInvocation } from "../../../../src/protocol/command-catalog-protocol-types.js"
import { createCommandInvokeService, type CommandInvokeDeps } from "../../../../src/orchestration/app-service/command-invoke-service.js"
import type { CommandHost } from "../../../../src/orchestration/app-service/command-host.js"
import type { ModuleHealthCheck } from "../../../../src/orchestration/module-health.js"
import { SHIPPED_MODULES, type FirstPartyModule, type FirstPartyModuleComposition } from "../../../../src/orchestration/modules.js"
import { EXPERIMENT_OPERATION_KIND, experimentInterruptionMessage } from "../../../../src/orchestration/modules/experiments/operation-owner.js"
import type { ChatInputLike } from "../../../../src/infra/chat-input.js"
import { createDefinitionAvailability } from "../../../../src/orchestration/app-service/definition-availability.js"
import { moduleDescriptor } from "../../../../src/orchestration/config/module-descriptor.js"
import { MODULE_IDS, moduleDisabledReason, type ModuleId } from "../../../../src/protocol/module-ids.js"
import { getPersonaMetadataIndex } from "../../../../src/workflows/agents/agent-roles.js"
import { assembleSkillInvocation } from "../../../../src/workflows/skill-invocation.js"
import { testDirectories } from "../../../helpers/directories.js"
import { repoDefinitions, repoModules } from "../../../helpers/project-definitions.js"
import { workflowParentBinding } from "../../../helpers/workflow-parent.js"
import { createSupervisorTestContext, disposeSupervisorTestContext, mockRunner, supervisorBaseDeps, supervisorConversationFixture, type SupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"

/** A module the kernel has never heard of. Its command reaches the service
 *  through the composition alone: no router, host, or protocol edit names it. */
const invocations: Array<{ readonly host: CommandHost; readonly argument: string | undefined }> = []
const syntheticModule = {
  id: "synthetic-commands",
  dependencies: [],
  availability: { kind: "available" },
  contributions: [
    { domain: "commands", id: "echo", value: {
      id: "echo",
      title: "Echo",
      description: "Answers its argument",
      aliases: ["say"],
      execute: async (host, argument) => {
        invocations.push({ host, argument })
        if (argument === "throw") throw new Error("the handler threw")
        return { kind: "message", message: argument ?? "(no argument)" }
      },
    } },
    { domain: "commands", id: "in-flight", value: {
      id: "in-flight",
      title: "In-flight",
      description: "Reads in-flight work",
      aliases: [],
      execute: async (host) => {
        const rows = await host.session?.readInFlight(["test.in-flight"])
        return { kind: "message", message: String(rows?.length ?? 0) }
      },
    } },
  ],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule

const REVISION = 7
const catalog = (modules: readonly FirstPartyModule[], disabledModuleIds: readonly string[] = []): FirstPartyModuleComposition =>
  composeModules(modules, { disabledModuleIds })

let ctx: SupervisorTestContext
beforeEach(() => {
  ctx = createSupervisorTestContext()
  invocations.length = 0
})
afterEach(async () => { await disposeSupervisorTestContext(ctx) })

function supervisorDouble(overrides: Partial<CommandInvokeDeps["supervisor"]> = {}) {
  const calls: string[] = []
  const sent: ChatInputLike[] = []
  return {
    calls,
    sent,
    supervisor: {
      activateSession: async (sessionId: string) => { calls.push(`activate:${sessionId}`); return true },
      compactChat: async (sessionId: string) => { calls.push(`compact:${sessionId}`); return true },
      ensureChatRunner: async (sessionId: string) => mockRunner(sessionId),
      forkSession: async (sessionId: string) => { calls.push(`fork:${sessionId}`); return `${sessionId}-fork` },
      interruptSession: async (sessionId: string) => { calls.push(`interrupt:${sessionId}`); return true },
      requestChatContext: async (sessionId: string) => { calls.push(`prompt:${sessionId}`); return true },
      reviewChat: async (sessionId: string) => { calls.push(`review:${sessionId}`); return true },
      sendChat: async (sessionId: string, input: ChatInputLike) => { calls.push(`send:${sessionId}`); sent.push(input); return { ok: true } as const },
      ...overrides,
    },
  }
}

/** Skill availability over the checked-out repository's definitions, as a
 *  source run publishes it under the selection `moduleIds`. */
async function repoAvailability(moduleIds: readonly ModuleId[]) {
  return createDefinitionAvailability({ definitions: repoDefinitions(), modules: repoModules, capabilities: { state: () => moduleDescriptor(moduleIds, moduleIds, false) } })
}

function service(overrides: Partial<CommandInvokeDeps> = {}) {
  const double = supervisorDouble()
  const deps: CommandInvokeDeps = {
    catalog: { snapshot: () => ({ revision: REVISION, builtInCommands: [], offCommands: [] }) },
    availability: { snapshot: () => { throw new Error("this command starts no method") } },
    moduleSelection: () => catalog([...SHIPPED_MODULES, syntheticModule]),
    manager: ctx.manager,
    sessionStore: ctx.sessionStore,
    supervisor: double.supervisor,
    projectionReader: ctx.runtime.runSync(EventReaderService),
    eventWriter: ctx.runtime.runSync(EventStoreWriterService),
    directories: testDirectories(ctx.baseDir),
    authDirectory: () => ctx.baseDir,
    ...overrides,
  }
  return { invoke: createCommandInvokeService(deps).invoke, calls: double.calls, sent: double.sent }
}

const invocation = (fields: Partial<RuntimeCommandInvocation> & Pick<RuntimeCommandInvocation, "id">): RuntimeCommandInvocation =>
  ({ type: "command.invoke", revision: REVISION, ...fields })

describe("command invocation", () => {
  test("an enabled registration is the whole route: a synthetic command executes with its argument verbatim", async () => {
    const { invoke } = service()
    expect(await invoke(invocation({ id: "echo", argument: "  spaced   argument " }))).toEqual({ kind: "message", message: "  spaced   argument " })
    expect(invocations.map((call) => call.argument)).toEqual(["  spaced   argument "])
    expect(invocations[0]?.host.session).toBeUndefined()
    expect(invocations[0]?.host.directories.projectRoot).toBe(testDirectories(ctx.baseDir).projectRoot)
  })

  test("a disabled module's command names its module, and an unknown id answers unavailable, without executing", async () => {
    const { invoke } = service({ moduleSelection: () => catalog([...SHIPPED_MODULES, syntheticModule], ["synthetic-commands", "papercuts"]) })
    expect(await invoke(invocation({ id: "echo" }))).toEqual({ kind: "unavailable", message: '"/echo" needs the synthetic-commands module, which is off. Turn it on in Settings.' })
    expect(await invoke(invocation({ id: "papercuts" }))).toEqual({ kind: "unavailable", message: '"/papercuts" needs the Papercuts module, which is off. Turn it on in Settings.' })
    expect(await invoke(invocation({ id: "nope" }))).toEqual({ kind: "unavailable", message: '"/nope" is not available to invoke' })
    expect(invocations).toEqual([])
  })

  test("a withheld kernel command names the modules that provide it while an available one runs", async () => {
    const { invoke: withoutProducers } = service({ moduleSelection: () => catalog(SHIPPED_MODULES, ["background-commands", "subagents", "workflows"]) })
    expect(await withoutProducers(invocation({ id: "bg" }))).toEqual({ kind: "unavailable", message: '"/bg" needs one of the Background Commands, Subagents, or Workflows modules, which are off. Turn one on in Settings.' })
    const { invoke: uninstalled } = service({ moduleSelection: () => catalog([syntheticModule]) })
    expect(await uninstalled(invocation({ id: "bg" }))).toEqual({ kind: "unavailable", message: '"/bg" is not available to invoke' })
    const { invoke } = service()
    expect(await invoke(invocation({ id: "bg" }))).toEqual({ kind: "open", surface: "background" })
  })

  test("/doctor reports every enabled module's health section in publication order, and a failed check reports its failure without hiding the others", async () => {
    const healthModule = (id: string, sections: readonly ModuleHealthCheck[]): FirstPartyModule => ({
      id, dependencies: [], availability: { kind: "available" }, observers: [], transformers: [], gates: [],
      contributions: sections.map((value) => ({ domain: "health" as const, id: value.title, value })),
    })
    const healthy = healthModule("healthy", [{ title: "Library", check: async (host) => ({ attention: false, lines: [`Reads ${host.authDirectory()}.`] }) }])
    const failing = healthModule("failing", [
      { title: "Program", check: async () => ({ attention: true, lines: ["Install it."] }) },
      { title: "Broken", check: async () => { throw new Error("no answer") } },
    ])
    const { invoke } = service({ moduleSelection: () => catalog([healthy, failing]) })
    expect(await invoke(invocation({ id: "doctor" }))).toEqual({ kind: "warning", message: `Broken\n  The check failed: no answer\nLibrary\n  Reads ${ctx.baseDir}.\nProgram\n  Install it.` })
    const { invoke: allHealthy } = service({ moduleSelection: () => catalog([healthy, failing], ["failing"]) })
    expect(await allHealthy(invocation({ id: "doctor" }))).toEqual({ kind: "message", message: `Library\n  Reads ${ctx.baseDir}.` })
    const { invoke: noChecks } = service({ moduleSelection: () => catalog([healthy, failing], ["healthy", "failing"]) })
    expect(await noChecks(invocation({ id: "doctor" }))).toMatchObject({ kind: "unavailable" })
  })

  test("a stale revision answers stale even when the id exists", async () => {
    const { invoke } = service()
    expect(await invoke(invocation({ id: "echo", revision: REVISION - 1 }))).toEqual({ kind: "stale" })
    expect(invocations).toEqual([])
  })

  test("an alias is not an id", async () => {
    const { invoke } = service()
    expect(await invoke(invocation({ id: "say" }))).toEqual({ kind: "unavailable", message: '"/say" is not available to invoke' })
  })

  test("a missing, deleted, or workflow session answers unavailable without executing", async () => {
    const { invoke } = service()
    const deleted = await ctx.manager.createChat({ name: "Gone" })
    const deletion = await ctx.manager.admitDeletion(deleted)
    for (const target of deletion.targets) await ctx.manager.finalizeDeletionTarget(target)
    const workflow = await ctx.manager.publishWorkflow({ id: ctx.manager.allocateId(), description: "QA", workflowDefinitionId: "qa", initialRoles: {}, facts: [], launchedFrom: await workflowParentBinding(ctx.manager, { workflowDefinitionId: "qa" }) })
    for (const sessionId of ["never-existed", deleted, workflow]) {
      expect(await invoke(invocation({ id: "echo", sessionId }))).toEqual({ kind: "unavailable", message: `"/echo" needs a chat session, and ${sessionId} is not one` })
    }
    expect(invocations).toEqual([])
  })

  test("a chat session reaches the handler as kernel primitives bound to it", async () => {
    const { invoke, calls } = service()
    const sessionId = await ctx.manager.createChat({ name: "Live" })
    expect(await invoke(invocation({ id: "echo", sessionId, argument: "hi" }))).toEqual({ kind: "message", message: "hi" })
    const session = invocations[0]?.host.session
    if (!session) throw new Error("expected a resolved session")
    expect(session.id).toBe(sessionId)
    expect(session.executionCwd).toBe(testDirectories(ctx.baseDir).projectRoot)
    expect(await session.prompt({ text: "go", label: "/echo", context: "ctx" })).toBe(true)
    expect(await session.review()).toBe(true)
    session.interrupt()
    expect(await session.fork()).toBe(`${sessionId}-fork`)
    expect(calls).toEqual([`prompt:${sessionId}`, `review:${sessionId}`, `interrupt:${sessionId}`, `fork:${sessionId}`])
  })

  test("a command on a chat whose recorded directory was removed runs and receives the recorded directory", async () => {
    // Commands read context; agent work that one starts goes through the
    // chat's own start, which refuses the removed directory.
    const worktree = join(realpathSync(ctx.baseDir), "worktree")
    mkdirSync(worktree)
    const sessionId = await createSessionManager({ projectRoot: ctx.baseDir, executionCwd: worktree, store: ctx.store }).createChat({ name: "Removed worktree" })
    rmSync(worktree, { recursive: true })
    const { invoke } = service()

    expect(await invoke(invocation({ id: "echo", sessionId, argument: "hi" }))).toEqual({ kind: "message", message: "hi" })
    expect(invocations[0]?.host.session?.executionCwd).toBe(worktree)
  })

  test("a command session awaits its asynchronous in-flight state read", async () => {
    const sessionId = await ctx.manager.createChat({ name: "Async read" })
    if (!ctx.store.putInFlight) throw new Error("Fixture requires in-flight write authority")
    await ctx.store.putInFlight(sessionId, "test.in-flight", "one", { value: 1 })
    const direct = ctx.runtime.runSync(EventReaderService)
    let released = false
    const projectionReader = {
      ...direct,
      async readInFlight(targetSessionId: string, kinds: string | readonly string[]) {
        await Promise.resolve()
        released = true
        return direct.readInFlight(targetSessionId, kinds)
      },
    }
    const { invoke } = service({ projectionReader })

    expect(await invoke(invocation({ id: "in-flight", sessionId }))).toEqual({ kind: "message", message: "1" })
    expect(released).toBe(true)
  })

  test("a command lends a cold chat's session host without holding or joining a model turn", async () => {
    const handle = moduleRuntimeHandle<{ readonly answer: string }>("synthetic-commands")
    const instance = { answer: "session-owned" }
    const sessionId = await ctx.manager.createChat({ name: "Cold" })
    await supervisorConversationFixture(() => ctx).commitUserTurn(sessionId)
    let attached = 0
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, ctx.sessionStore, {
        createRunner: async () => {
          attached += 1
          return mockRunner(sessionId, {
            chatModuleHosts: composeModuleRuntimes([[handle.moduleId, instance]]),
            hold: () => { throw new Error("must not hold") },
            awaitTurnSettlement: () => { throw new Error("must not wait for model work") },
          })
        },
      }),
      sessionViewLoader: { load: (id) => loadSessionView(id, asAsyncEventReadSurface(ctx.store), asAsyncEventReadSurface(ctx.store)) },
    })
    const { invoke } = service({ supervisor })
    try {
      await invoke(invocation({ id: "echo", sessionId }))
      const session = invocations[0]?.host.session
      if (!session) throw new Error("expected a command session")
      expect(await session.host(handle)).toBe(instance)
      expect(await session.host(handle)).toBe(instance)
      expect(attached).toBe(1)
    } finally {
      await supervisor.disposeAll()
    }
  })

  test("experiment start awaits asynchronous interruption evidence and does not redispatch recorded work", async () => {
    const sessionId = await ctx.manager.createChat({ name: "Interrupted experiment" })
    if (!ctx.store.putInFlight) throw new Error("Fixture requires in-flight write authority")
    await ctx.store.putInFlight(sessionId, EXPERIMENT_OPERATION_KIND, "run", { state: "running" })
    const direct = ctx.runtime.runSync(EventReaderService)
    let reads = 0
    const projectionReader = {
      ...direct,
      async readInFlight(targetSessionId: string, kinds: string | readonly string[]) {
        await Promise.resolve()
        reads += 1
        return direct.readInFlight(targetSessionId, kinds)
      },
    }
    const { invoke, calls } = service({ projectionReader, runOwnedCommand: async () => { throw new Error("recorded work must not run") } })

    expect(await invoke(invocation({ id: "experiment", sessionId, argument: "start" }))).toEqual({ kind: "warning", message: experimentInterruptionMessage })
    expect(reads).toBe(1)
    expect(calls).toEqual([])
  })

  test("a command starts its skill's method as a committed turn labelled with the typed command", async () => {
    const all = await repoAvailability(MODULE_IDS)
    const { invoke, sent, calls } = service({ availability: all, moduleSelection: () => catalog(repoModules), runOwnedCommand: async () => { throw new Error("a method runs no process") } })
    const sessionId = await ctx.manager.createChat({ name: "Methods" })

    expect(await invoke(invocation({ id: "experiment", sessionId, argument: "design make tests faster" }))).toEqual({ kind: "none" })
    expect(await invoke(invocation({ id: "experiment", sessionId, argument: "finalize" }))).toEqual({ kind: "none" })
    expect(await invoke(invocation({ id: "bug-report-triage", sessionId }))).toEqual({ kind: "none" })

    // The same assembly the model's skill tool loads, with the goal as ARGUMENTS.
    const skills = all.snapshot().skillRevision
    const rendered = (id: string, args?: string) => {
      const skill = skills.skills.get(id)
      if (!skill) throw new Error(`the repository installs ${id}`)
      return assembleSkillInvocation(skill, args, { skills, personaIndex: getPersonaMetadataIndex() })
    }
    expect(sent).toEqual([
      { text: rendered("experiment-charter", "make tests faster"), invocation: { label: "/experiment design", args: "make tests faster" } },
      { text: rendered("experiment-finalize"), invocation: { label: "/experiment finalize" } },
      { text: rendered("bug-report-triage"), invocation: { label: "/bug-report-triage" } },
    ])
    expect(calls).toEqual([`send:${sessionId}`, `send:${sessionId}`, `send:${sessionId}`])
  })

  test("a command whose skill is unavailable names the skill and starts no turn", async () => {
    const withoutSkills = await repoAvailability(MODULE_IDS.filter((id) => id !== "skills"))
    const { invoke, sent } = service({ availability: withoutSkills, moduleSelection: () => catalog(repoModules, ["skills"]), runOwnedCommand: async () => { throw new Error("a method runs no process") } })
    const sessionId = await ctx.manager.createChat({ name: "No skills" })

    expect(await invoke(invocation({ id: "experiment", sessionId, argument: "design make tests faster" }))).toEqual({
      kind: "warning",
      message: `/experiment design cannot start the experiment-charter skill: ${moduleDisabledReason(["skills"])}.`,
    })
    expect(await invoke(invocation({ id: "bug-report-triage", sessionId }))).toMatchObject({ kind: "warning", message: expect.stringContaining("/bug-report-triage cannot start the bug-report-triage skill") })
    expect(sent).toEqual([])
  })

  test("the kernel fork answers focus-session for the created chat", async () => {
    const { invoke } = service()
    const sessionId = await ctx.manager.createChat({ name: "Source" })
    expect(await invoke(invocation({ id: "fork", sessionId }))).toEqual({ kind: "focus-session", sessionId: `${sessionId}-fork` })
    expect(await invoke(invocation({ id: "fork" }))).toEqual({ kind: "warning", message: "No active chat session" })
  })

  test("a thrown handler error answers warning with its message", async () => {
    const { invoke } = service()
    expect(await invoke(invocation({ id: "echo", argument: "throw" }))).toEqual({ kind: "warning", message: "the handler threw" })
    const sessionId = await ctx.manager.createChat({ name: "Live" })
    expect(await invoke(invocation({ id: "echo", sessionId, argument: "throw" }))).toEqual({ kind: "warning", message: "the handler threw" })
  })

  test("invocations on one session run one at a time, in order", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const order: string[] = []
    const slowModule = {
      ...syntheticModule,
      id: "slow-commands",
      contributions: [{ domain: "commands", id: "slow", value: {
        id: "slow", title: "Slow", description: "Waits", aliases: [],
        execute: async () => { order.push("slow:start"); await gate; order.push("slow:end"); return { kind: "none" } },
      } }],
    } as const satisfies FirstPartyModule
    const { invoke } = service({ moduleSelection: () => catalog([syntheticModule, slowModule]) })
    const sessionId = await ctx.manager.createChat({ name: "Serial" })
    const first = invoke(invocation({ id: "slow", sessionId }))
    const second = invoke(invocation({ id: "echo", sessionId, argument: "after" })).then((outcome) => { order.push("echo:done"); return outcome })
    await Bun.sleep(0)
    expect(order).toEqual(["slow:start"])
    release()
    expect(await first).toEqual({ kind: "none" })
    expect(await second).toEqual({ kind: "message", message: "after" })
    expect(order).toEqual(["slow:start", "slow:end", "echo:done"])
  })
})
