/** The process-scoped service contract and the notify seam, proven with a
 *  module the runtime has never heard of: it declares a service and a notify
 *  observer, composition builds the service once for an enabled module, and a
 *  kernel-raised episode reaches it through the seam with no host edit. */

import { describe, expect, it } from "bun:test"
import { composeModules } from "../../../../src/infra/module-descriptor.js"
import { moduleServiceHandle } from "../../../../src/infra/module-service.js"
import type { NotificationEpisodeInput } from "../../../../src/infra/notification-episode.js"
import { composeModuleProcessServices, composePortableModuleServices, createAccountModuleServiceOwner, createNotifySeam, type ModuleProcessServices, type PortableModuleServices } from "../../../../src/orchestration/app-service/module-service-host.js"
import { composeRealmModuleSnapshot, type FirstPartyModule } from "../../../../src/orchestration/modules.js"
import { errorMessage } from "../../../../src/infra/error-message.js"
import { temporaryDirectories, testDirectories } from "../../../helpers/directories.js"
import { CONFIG_VALUE_ABSENT, createRuntimeConfigOwner } from "../../../../src/orchestration/config/runtime-config-owner.js"
import { remoteModule } from "../../../../src/orchestration/modules/remote/module.js"
import { remoteConfigSection } from "../../../../src/orchestration/modules/remote/config.js"
import { kernelPorts } from "../../../helpers/module-kernel.js"
import { refusingLauncher } from "../../../helpers/launcher-fake.js"

interface ProbeService {
  readonly received: NotificationEpisodeInput[]
  readonly dependencyGreeting: string | undefined
  dispose(): void
}

interface GreeterService {
  readonly greeting: string
  dispose(): void
}

const probeService = moduleServiceHandle<ProbeService>("probe")
const greeterService = moduleServiceHandle<GreeterService>("greeter")
const constructions: string[] = []

const greeterModule = {
  id: "greeter",
  dependencies: [],
  availability: { kind: "available" },
  service: { handle: greeterService, create: () => { constructions.push("greeter"); return { greeting: "hello", dispose() {} } } },
  contributions: [],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule

const probeModule = {
  id: "probe",
  dependencies: ["greeter"],
  availability: { kind: "available" },
  service: {
    handle: probeService,
    create: (services: ModuleProcessServices): ProbeService => {
      constructions.push("probe")
      return { received: [], dependencyGreeting: services.modules.get(greeterService)?.greeting, dispose() {} }
    },
  },
  contributions: [],
  observers: [{ seam: "notify", observer: (episode, modules) => { modules.get(probeService)?.received.push(episode) } }],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule

const catalog: readonly FirstPartyModule[] = [probeModule, greeterModule]
const kernel = kernelPorts()
const refuse = (port: string) => (): never => { throw new Error(`the synthetic account services read no ${port}`) }

/** Account ports for synthetic account services that read none of them: every call refuses. */
const refusingAccountPorts: Omit<Parameters<typeof createAccountModuleServiceOwner>[0], "onStartFailure"> = {
  userDataRoot: "/scratch/account/.flywheel",
  version: "0.0.0-test",
  registry: { list: refuse("registry.list"), record: refuse("registry.record"), forget: refuse("registry.forget"), watch: refuse("registry.watch"), dispose: refuse("registry.dispose") },
  projects: {
    open: refuse("projects.open"), close: refuse("projects.close"), state: refuse("projects.state"), project: refuse("projects.project"), slots: refuse("projects.slots"),
    watch: refuse("projects.watch"), openAdmission: refuse("projects.openAdmission"), closeAdmission: refuse("projects.closeAdmission"), dispose: refuse("projects.dispose"),
  },
  projectClone: { clone: refuse("projectClone.clone") },
  launcher: { scope: refusingLauncher, guardian: { openGeneration: refuse("guardian.openGeneration"), pid: refuse("guardian.pid") }, startGuardian: refuse("launcher.startGuardian") },
  webClient: refuse("webClient"),
}
const episode: NotificationEpisodeInput = { type: "raise", occurrence: { sourceId: "probe:condition", title: "Probe", message: "A condition", severity: "warning", action: { kind: "open-settings" } } }

describe("a synthetic module under the service contract", () => {
  it("builds one service per enabled module in dependency order and delivers a kernel-raised episode through the seam", async () => {
    constructions.length = 0
    const composition = composeModules(catalog)
    const services = composeModuleProcessServices(catalog, () => composition.enabledModuleIds, kernel)
    services.reconcile()
    expect(constructions).toEqual(["greeter", "probe"])
    expect(services.instances.map(([id]) => id)).toEqual(["greeter", "probe"])
    expect(services.services.get(probeService)?.dependencyGreeting).toBe("hello")

    const notify = createNotifySeam(() => composeRealmModuleSnapshot({ moduleIds: composition.enabledModuleIds }, catalog), () => services.services)
    await notify(episode)
    expect(services.services.get(probeService)?.received).toEqual([episode])
  })

  it("never constructs the service of a disabled module, and a raise while it is off settles at once", async () => {
    constructions.length = 0
    const composition = composeModules(catalog, { disabledModuleIds: ["probe"] })
    const services = composeModuleProcessServices(catalog, () => composition.enabledModuleIds, kernel)
    services.reconcile()
    expect(constructions).toEqual(["greeter"])
    expect(services.services.get(probeService)).toBeUndefined()

    const notify = createNotifySeam(() => composeRealmModuleSnapshot({ moduleIds: composition.enabledModuleIds }, catalog), () => services.services)
    await expect(notify(episode)).resolves.toBeUndefined()
  })

  it("builds only the portable services over the portable kernel, and settles their startup with every notice a person must act on", async () => {
    constructions.length = 0
    const directories = testDirectories("/scratch/portable")
    const portable = { ...greeterModule, id: "portable", service: { handle: moduleServiceHandle<GreeterService & { settleStartup(): Promise<readonly string[]> }>("portable"), portable: true as const, create: (services: PortableModuleServices) => {
      constructions.push("portable")
      return { greeting: services.directories.projectRoot, settleStartup: async () => ["Repair the portable thing."], dispose() {} }
    } } } satisfies FirstPartyModule
    const failing = { ...greeterModule, id: "failing", service: { handle: moduleServiceHandle<GreeterService>("failing"), portable: true as const, create: () => ({ greeting: "", settleStartup: async (): Promise<readonly string[]> => { throw new Error("startup settlement failed") }, dispose() {} }) } } satisfies FirstPartyModule
    const modules: readonly FirstPartyModule[] = [portable, failing, probeModule, greeterModule]
    const composition = composeModules(modules)
    const services = composePortableModuleServices(modules, () => composition.enabledModuleIds, kernelPorts({ directories }))
    services.start()
    expect(constructions).toEqual(["portable"])
    expect(services.instances.map(([id]) => id)).toEqual(["portable", "failing"])
    expect(services.services.get(portable.service.handle)?.greeting).toBe(directories.projectRoot)
    expect(await services.settleStartup()).toEqual(["Repair the portable thing."])
    await services.dispose()
  })

  it("runs every observer when one throws, and answers the producer with that failure", async () => {
    const throwing = { ...probeModule, id: "thrower", dependencies: [], observers: [{ seam: "notify" as const, observer: () => { throw new Error("observer failed") } }] } satisfies FirstPartyModule
    const modules: readonly FirstPartyModule[] = [throwing, probeModule, greeterModule]
    const composition = composeModules(modules)
    const services = composeModuleProcessServices(modules, () => composition.enabledModuleIds, kernel)
    services.reconcile()
    const notify = createNotifySeam(() => composeRealmModuleSnapshot({ moduleIds: composition.enabledModuleIds }, modules), () => services.services)
    await expect(notify(episode)).rejects.toThrow("observer failed")
    expect(services.services.get(probeService)?.received).toEqual([episode])
  })
})


it("activates initially disabled services once in dependency order, starts only when ready, and retains one shutdown owner", async () => {
  const calls: string[] = []
  let selected: readonly string[] = []
  const dependency = { ...greeterModule, service: { handle: greeterService, create: () => {
    calls.push("create:greeter")
    return { greeting: "hello", start() { calls.push("start:greeter") }, closeAdmission() { calls.push("close:greeter") }, dispose() { calls.push("dispose:greeter") } }
  } } } satisfies FirstPartyModule
  const dependent = { ...probeModule, service: { handle: probeService, create: (ports: ModuleProcessServices) => {
    calls.push("create:probe")
    return { received: [], dependencyGreeting: ports.modules.get(greeterService)?.greeting, start() { calls.push("start:probe") }, closeAdmission() { calls.push("close:probe") }, dispose() { calls.push("dispose:probe") } }
  } } } satisfies FirstPartyModule
  const never = { ...greeterModule, id: "never", service: { handle: moduleServiceHandle("never"), create: () => { throw new Error("disabled factory ran") } } } satisfies FirstPartyModule
  const owner = composeModuleProcessServices([dependent, dependency, never], () => selected, kernel)
  const bindings = owner.services
  owner.reconcile()
  expect(calls).toEqual([])
  selected = ["probe", "greeter"]
  owner.reconcile()
  expect(calls).toEqual(["create:greeter", "create:probe"])
  expect(bindings.get(probeService)?.dependencyGreeting).toBe("hello")
  owner.start()
  owner.reconcile()
  selected = []
  owner.reconcile()
  selected = ["probe", "greeter"]
  owner.reconcile()
  expect(calls).toEqual(["create:greeter", "create:probe", "start:greeter", "start:probe"])
  owner.closeAdmission()
  selected = ["never", "probe", "greeter"]
  owner.reconcile()
  owner.start()
  await Promise.all([owner.dispose(), owner.dispose()])
  expect(calls.slice(4)).toEqual(["close:probe", "close:greeter", "dispose:probe", "dispose:greeter"])
})

it("starts a service activated after kernel readiness and releases dependencies after constructor failure", async () => {
  const calls: string[] = []
  let selected: readonly string[] = []
  const dependency = { ...greeterModule, service: { handle: greeterService, create: () => ({ greeting: "hello", start() { calls.push("start") }, dispose() { calls.push("dispose") } }) } } satisfies FirstPartyModule
  const failing = { ...probeModule, service: { handle: probeService, create: () => { throw new Error("construction failed") } } } satisfies FirstPartyModule
  const owner = composeModuleProcessServices([failing, dependency], () => selected, kernel)
  owner.start()
  expect(calls).toEqual([])
  selected = ["probe", "greeter"]
  expect(() => owner.reconcile()).toThrow("construction failed")
  expect(calls).toEqual(["start"])
  await owner.dispose()
  expect(calls).toEqual(["start", "dispose"])
})

it("settles every activated service even when close admission or disposal fails", async () => {
  const calls: string[] = []
  const bad = { ...probeModule, service: { handle: probeService, create: () => ({ dispose() { calls.push("bad-dispose"); throw new Error("dispose failed") }, closeAdmission() { calls.push("bad-close"); throw new Error("close failed") } }) } } satisfies FirstPartyModule
  const good = { ...greeterModule, service: { handle: greeterService, create: () => ({ greeting: "hello", dispose() { calls.push("good-dispose") }, closeAdmission() { calls.push("good-close") } }) } } satisfies FirstPartyModule
  const owner = composeModuleProcessServices([bad, good], () => ["probe", "greeter"], kernel)
  owner.reconcile()
  owner.closeAdmission()
  await expect(owner.dispose()).rejects.toThrow("Module services failed to settle")
  expect(calls).toEqual(["bad-close", "good-close", "bad-dispose", "good-dispose"])
})


it("retries a failed activation without rebuilding a successful dependency", async () => {
  const calls: string[] = []
  let fail = true
  const dependency = { ...greeterModule, service: { handle: greeterService, create: () => {
    calls.push("create:dependency")
    return { greeting: "hello", dispose() {} }
  } } } satisfies FirstPartyModule
  const retrying = { ...probeModule, service: { handle: probeService, create: () => {
    calls.push("create:dependent")
    if (fail) throw new Error("temporary failure")
    return { received: [], dependencyGreeting: "hello", start() { calls.push("start:dependent") }, dispose() {} }
  } } } satisfies FirstPartyModule
  const owner = composeModuleProcessServices([retrying, dependency], () => ["probe", "greeter"], kernel)
  expect(() => owner.start()).toThrow("temporary failure")
  fail = false
  owner.reconcile()
  owner.reconcile()
  expect(calls).toEqual(["create:dependency", "create:dependent", "create:dependent", "start:dependent"])
  expect(owner.services.get(probeService)?.dependencyGreeting).toBe("hello")
  await owner.dispose()
})

it("contains an account-lifetime service that throws as it starts to its own module, starts the others, and serves a module attach only through a live service", async () => {
  const started = { dispose: async () => {}, serveRequest: async (request: unknown, answer: (payload: unknown) => Promise<void>) => { await answer({ echoed: request }) } }
  const accountModule = (id: string, create: () => typeof started) => ({ ...greeterModule, id, service: undefined, contributions: [{ domain: "accountServices" as const, id, value: { configuration: () => null, create } }] }) satisfies FirstPartyModule
  const modules: readonly FirstPartyModule[] = [
    accountModule("failing", () => { throw new Error("the pairing store cannot be watched") }),
    accountModule("working", () => started),
  ]
  const owner = createAccountModuleServiceOwner({ ...refusingAccountPorts, onStartFailure() {} })
  try {
    const start = await owner.reconcile(composeModules(modules), {})
    expect(start.services).toEqual([started])
    expect([...start.failures].map(([module, error]) => [module, errorMessage(error)])).toEqual([["failing", "the pairing store cannot be watched"]])
    const withdrawn = new AbortController().signal
    const answers: unknown[] = []
    await owner.serveRequest("working", { type: "probe" }, async (answer) => { answers.push(answer) }, withdrawn)
    expect(answers).toEqual([{ echoed: { type: "probe" } }])
    await expect(owner.serveRequest("failing", { type: "probe" }, async () => {}, withdrawn)).rejects.toThrow("The failing module's account service could not start: the pairing store cannot be watched")
    await owner.reconcile(composeModules(modules, { disabledModuleIds: ["working"] }), {})
    await expect(owner.serveRequest("working", { type: "probe" }, async () => {}, withdrawn)).rejects.toThrow("The working module is off for this account.")
  } finally { await owner.dispose() }
})

const temporaryDirectory = temporaryDirectories()

it("keeps account service instances through notice writes and reconciles actual inputs and selection", async () => {
  const instances: Array<{ dispose(): Promise<void>; disposed: boolean }> = []
  const accountContribution = remoteModule.contributions.find((contribution) => contribution.domain === "accountServices")!
  const module: FirstPartyModule = {
    ...remoteModule, service: undefined,
    contributions: [{
      ...accountContribution, value: {
        ...accountContribution.value,
        create() {
          const service = { disposed: false, dispose: async () => { service.disposed = true } }
          instances.push(service)
          return service
        },
      },
    }],
  }
  const config = await createRuntimeConfigOwner({ userDataRoot: temporaryDirectory("account-service-config-"), watch: false })
  const owner = createAccountModuleServiceOwner({ ...refusingAccountPorts, onStartFailure() {} })
  const composition = composeModules([module])
  try {
    const initial = await owner.reconcile(composition, config.snapshot().config)
    expect(await config.mutate("acknowledgedReleaseVersion", CONFIG_VALUE_ABSENT, "0.1.0")).toMatchObject({ ok: true })
    expect((await owner.reconcile(composition, config.snapshot().config)).services[0]).toBe(initial.services[0])
    expect(await config.mutate("acknowledgedReleaseVersion", "0.1.0", "0.1.1")).toMatchObject({ ok: true })
    expect((await owner.reconcile(composition, config.snapshot().config)).services[0]).toBe(initial.services[0])
    expect(await config.mutate("tabsHintDismissed", false, true)).toMatchObject({ ok: true })
    expect((await owner.reconcile(composition, config.snapshot().config)).services[0]).toBe(initial.services[0])
    expect(await config.mutateModuleSetting(remoteConfigSection, "keep_awake", true, false, true)).toMatchObject({ ok: true })
    const changed = await owner.reconcile(composition, config.snapshot().config)
    expect(changed.services[0]).not.toBe(initial.services[0])
    expect(instances[0]?.disposed).toBe(true)
    const disabled = await owner.reconcile(composeModules([module], { disabledModuleIds: ["remote"] }), config.snapshot().config)
    expect(disabled.services).toEqual([])
    expect(instances[1]?.disposed).toBe(true)
  } finally {
    await owner.dispose()
    await config.dispose()
  }
})
