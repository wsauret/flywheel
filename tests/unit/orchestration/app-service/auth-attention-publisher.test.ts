import { describe, expect, test } from "bun:test"
import { createAuthAttentionPublisher } from "../../../../src/orchestration/app-service/auth-attention-publisher.js"
import type { NotificationEpisodeInput, NotificationOccurrence } from "../../../../src/infra/notification-episode.js"
import type { AuthFileAttention, RuntimeAuthView } from "../../../../src/protocol/auth-status-protocol-types.js"
import { composeModules } from "../../../../src/infra/module-descriptor.js"
import { composeModuleProcessServices, createNotifySeam } from "../../../../src/orchestration/app-service/module-service-host.js"
import { composeRealmModuleSnapshot, type FirstPartyModule } from "../../../../src/orchestration/modules.js"
import { kernelPorts } from "../../../helpers/module-kernel.js"

const view = (fileAttention?: AuthFileAttention): RuntimeAuthView => ({
  autoEnableNewModels: { enabled: true, eligibilityRevision: 0 },
  warnings: [],
  providers: [],
  authFilePath: "/scratch/auth.json",
  profile: { id: "default", displayName: "Default", source: "default", availableProfiles: [{ id: "default", displayName: "Default" }] },
  subscriptionSpendConsent: { kind: "available", profileId: "default", authorityIncarnation: "test", authorityRevision: 0, usageGeneration: 0, accounts: [] },
  ...(fileAttention === undefined ? {} : { fileAttention }),
})
const clear = view()
const malformed = view({ kind: "malformed", path: "/scratch/auth.json", message: "The authentication file is malformed." })
const resolveLegacy: NotificationEpisodeInput = { type: "resolve", sourceId: "runtime:auth-status-warning:default" }
const statementOf = (desired: readonly NotificationOccurrence[]): NotificationEpisodeInput[] => [{ type: "reconcile", prefix: "runtime:auth-attention:default:", desired }, resolveLegacy]
const fileEpisode: NotificationOccurrence = { sourceId: "runtime:auth-attention:default:file", title: "Authentication file needs attention", message: "Repair the authentication file at /scratch/auth.json.", severity: "warning", action: { kind: "open-auth" } }
// Every delivery of these fakes settles within microtasks, which all run before the next macrotask.
const flush = () => new Promise<void>((resolve) => { setImmediate(resolve) })
const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })

describe("auth attention publisher", () => {
  test("states a profile's attention once, and again only when it changes", async () => {
    const delivered: NotificationEpisodeInput[] = []
    const publisher = createAuthAttentionPublisher({ deliver: async (episode) => { delivered.push(episode) } })

    for (let offer = 0; offer < 5; offer += 1) publisher.state(malformed)
    await flush()
    expect(delivered).toEqual(statementOf([fileEpisode]))

    publisher.state(clear)
    publisher.state(clear)
    await flush()
    expect(delivered).toEqual([...statementOf([fileEpisode]), ...statementOf([])])

    // A removed profile's retirement follows the statement still in flight for it.
    publisher.state(malformed)
    publisher.retire("default")
    await publisher.dispose()
    expect(delivered.slice(4)).toEqual([...statementOf([fileEpisode]), ...statementOf([])])
  })

  test("offers made while a delivery is unanswered coalesce into one follow-up with the latest attention", async () => {
    const delivered: NotificationEpisodeInput[] = []
    let pending = 0
    let mostPending = 0
    const answers: (() => void)[] = []
    const publisher = createAuthAttentionPublisher({
      deliver: (episode) => {
        delivered.push(episode)
        mostPending = Math.max(mostPending, ++pending)
        return new Promise((resolve) => { answers.push(() => { pending -= 1; resolve() }) })
      },
    })

    publisher.state(clear)
    for (let offer = 0; offer < 200; offer += 1) publisher.state(offer % 2 === 0 ? malformed : clear)
    publisher.state(malformed)
    while (answers.length > 0) {
      answers.shift()?.()
      await flush()
    }
    expect(mostPending).toBe(1)
    expect(delivered).toEqual([...statementOf([]), ...statementOf([fileEpisode])])
    await publisher.dispose()
  })

  test("an observer that refuses the statement hears it again after a backoff, with no second auth change", async () => {
    const applied: NotificationEpisodeInput[] = []
    let refusals = 2
    const journal = {
      id: "journal",
      dependencies: [],
      availability: { kind: "available" },
      contributions: [],
      observers: [{ seam: "notify", observer: (episode: NotificationEpisodeInput) => {
        if (refusals > 0) throw new Error("notification journal append failed")
        applied.push(episode)
      } }],
      transformers: [],
      gates: [],
    } as const satisfies FirstPartyModule
    const modules: readonly FirstPartyModule[] = [journal]
    const composition = composeModules(modules)
    const services = composeModuleProcessServices(modules, () => composition.enabledModuleIds, kernelPorts())
    services.reconcile()
    const seam = createNotifySeam(() => composeRealmModuleSnapshot({ moduleIds: composition.enabledModuleIds }, modules), () => services.services)
    const backoffs: number[] = []
    const publisher = createAuthAttentionPublisher({
      deliver: async (episode) => {
        try { await seam(episode) } catch (error) { refusals -= 1; throw error }
      },
      retryDelayMs: (failedTries) => { backoffs.push(failedTries); return 1 },
    })

    publisher.state(malformed)
    for (let poll = 0; poll < 50 && applied.length < 2; poll += 1) await wait(2)
    expect(backoffs).toEqual([1, 2])
    expect(applied).toEqual(statementOf([fileEpisode]))

    // The delivered statement is not sent again by an equal offer.
    publisher.state(malformed)
    await wait(5)
    expect(applied).toEqual(statementOf([fileEpisode]))
    await publisher.dispose()
  })

  test("an offer of the same attention waits out the backoff, and shutdown cancels the retry", async () => {
    let attempts = 0
    const publisher = createAuthAttentionPublisher({
      deliver: async () => { attempts += 1; throw new Error("Notification capacity exceeded") },
      retryDelayMs: () => 10,
    })

    publisher.state(malformed)
    await flush()
    expect(attempts).toBe(1)
    publisher.state(malformed)
    await flush()
    expect(attempts).toBe(1)

    await publisher.dispose()
    await wait(20)
    expect(attempts).toBe(1)

    let heldAttempts = 0
    const held = Promise.withResolvers<void>()
    const draining = createAuthAttentionPublisher({
      deliver: async () => {
        heldAttempts += 1
        if (heldAttempts === 1) await held.promise
      },
    })
    draining.state(malformed)
    let disposed = false
    const disposal = draining.dispose().then(() => { disposed = true })
    draining.reconcile()
    held.reject(new Error("Notification capacity exceeded"))
    await flush()
    expect(heldAttempts).toBe(1)
    expect(disposed).toBe(true)
    await disposal
  })

  test("a notification consumer turned on hears the unchanged attention again", async () => {
    const delivered: NotificationEpisodeInput[] = []
    const publisher = createAuthAttentionPublisher({ deliver: async (episode) => { delivered.push(episode) } })

    publisher.state(malformed)
    await flush()
    publisher.reconcile()
    await flush()
    publisher.state(malformed)
    await flush()
    expect(delivered).toEqual([...statementOf([fileEpisode]), ...statementOf([fileEpisode])])
    await publisher.dispose()
  })
})
