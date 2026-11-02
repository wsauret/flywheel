import { describe, expect, it } from "bun:test"
import type { ProjectNotificationEpisode, ProjectNotificationProjection } from "../../../../src/protocol/modules/project-notifications.js"
import type { RuntimeAuthView } from "../../../../src/protocol/auth-status-protocol-types.js"
import type { SubscriptionSpendConsentView } from "../../../../src/protocol/subscription-spend-consent-protocol-types.js"
import { createProjectNotificationSink } from "../../../../src/orchestration/modules/project-notifications/sink.js"
import { createSubscriptionSpendConsentNotificationMaterializer, materializeSubscriptionSpendConsentAuthChange } from "../../../../src/orchestration/subscription-spend-consent/notification-materializer.js"

type AccountInput = {
  accountCorrelationId: string
  providerId?: string
  modes: ReadonlyArray<{ envelopeId: string; decision: "unreviewed" | "accepted" | "declined"; positiveEvidence?: boolean }>
}

function view(profileId: string, authorityIncarnation: string, accounts: readonly AccountInput[], authorityRevision = 1, usageGeneration = 1): SubscriptionSpendConsentView {
  return {
    kind: "available",
    profileId,
    usageGeneration,
    authorityIncarnation,
    authorityRevision,
    accounts: accounts.map((account) => ({
      accountCorrelationId: account.accountCorrelationId,
      providerId: account.providerId ?? "provider",
      providerDisplayName: "Provider",
      providerStatus: "ok",
      modes: account.modes.map((mode) => ({
        mode: "automatic",
        envelopeId: mode.envelopeId,
        evidence: { kind: "automatic-billing", enablement: mode.positiveEvidence === false ? "disabled" : "enabled" },
        decision: mode.decision,
      })),
    })),
  }
}

function journal() {
  const episodes = new Map<string, ProjectNotificationEpisode>()
  let sequence = 0
  const raised: string[] = []
  const resolved: string[] = []
  return {
    raised,
    resolved,
    hide(sourceId: string, kind: "dismissed" | "expired") {
      const episode = [...episodes.values()].find((candidate) => candidate.sourceId === sourceId && candidate.resolvedAt === undefined)
      if (!episode) throw new Error(`missing episode ${sourceId}`)
      episodes.set(episode.id, kind === "dismissed" ? { ...episode, dismissedAt: ++sequence } : { ...episode, expiresAt: 0 })
    },
    async raise(input: Omit<ProjectNotificationEpisode, "id" | "createdAt" | "expiresAt">) {
      const existing = this.activeEpisode(input.sourceId)
      if (existing) return existing
      const episode = { ...input, id: `episode-${++sequence}`, createdAt: sequence, expiresAt: sequence + 1_000 }
      episodes.set(episode.id, episode)
      this.raised.push(input.sourceId)
      return episode
    },
    async resolve(sourceId: string) {
      const episode = [...episodes.values()].find((candidate) => candidate.sourceId === sourceId && candidate.resolvedAt === undefined)
      if (!episode) return
      episodes.set(episode.id, { ...episode, resolvedAt: ++sequence })
      this.resolved.push(sourceId)
    },
    activeEpisode(sourceId: string) {
      return [...episodes.values()].find((episode) => episode.sourceId === sourceId && episode.resolvedAt === undefined)
    },
    async activeSourceIds() {
      return new Set([...episodes.values()].filter((episode) => episode.resolvedAt === undefined).map((episode) => episode.sourceId))
    },
    projection(): ProjectNotificationProjection {
      const values = [...episodes.values()]
      return { episodes: values, visible: values.filter((episode) => episode.resolvedAt === undefined && episode.dismissedAt === undefined && episode.expiresAt > 0), lastSeq: sequence }
    },
  }

}
/** The materializer over the notify seam, with the module's sink applying each input to the journal double
 *  in order; every call settles once the sink has applied what the call stated. */
function materializerOver(notifications: ReturnType<typeof journal>) {
  const sink = createProjectNotificationSink({ journal: notifications })
  const real = createSubscriptionSpendConsentNotificationMaterializer({ notify: (episode) => sink.apply(episode) })
  return {
    materialize: (consent: SubscriptionSpendConsentView) => real.materialize(consent),
    materializeAuth: (authView: RuntimeAuthView) => real.materializeAuth(authView),
    materializeAuthChange: (event: Parameters<typeof materializeSubscriptionSpendConsentAuthChange>[1]) => materializeSubscriptionSpendConsentAuthChange(real, event),
  }
}

function auth(consent: SubscriptionSpendConsentView, availableProfileIds: readonly string[]) {
  return {
    providers: [],
    warnings: [],
    profile: {
      id: consent.profileId,
      displayName: consent.profileId,
      source: "default" as const,
      availableProfiles: availableProfileIds.map((id) => ({ id, displayName: id })),
    },
    subscriptionSpendConsent: consent,
  }
}

describe("subscription spend consent notification materializer", () => {
  it("deduplicates one active episode per profile across restarts", async () => {
    const notifications = journal()
    const first = materializerOver(notifications)
    const consent = view("profile-a", "incarnation-a", [{ accountCorrelationId: "opaque-account", modes: [{ envelopeId: "opaque-envelope", decision: "unreviewed" }] }])

    await Promise.all([first.materialize(consent), first.materialize(consent)])
    const restarted = materializerOver(notifications)
    await restarted.materialize(consent)

    expect(notifications.raised).toHaveLength(1)
    expect(notifications.projection().visible[0]?.action).toEqual({ kind: "open-auth", providerId: "provider", accountCorrelationId: "opaque-account", envelopeId: "opaque-envelope" })
  })

  it("replaces an account notification when review advances to its next mode", async () => {
    const notifications = journal()
    const materializer = materializerOver(notifications)
    await materializer.materialize(view("profile-a", "incarnation-a", [{ accountCorrelationId: "opaque-account", modes: [
      { envelopeId: "prepaid", decision: "unreviewed" },
      { envelopeId: "automatic", decision: "unreviewed" },
    ] }]))
    await materializer.materialize(view("profile-a", "incarnation-a", [{ accountCorrelationId: "opaque-account", modes: [
      { envelopeId: "prepaid", decision: "accepted" },
      { envelopeId: "automatic", decision: "unreviewed" },
    ] }], 2))

    expect(notifications.resolved).toHaveLength(1)
    expect(notifications.raised).toHaveLength(2)
    expect(notifications.projection().visible[0]?.action).toEqual({ kind: "open-auth", providerId: "provider", accountCorrelationId: "opaque-account", envelopeId: "automatic" })
  })

  it("resolves after recreation when the current profile has no unreviewed envelopes", async () => {
    const notifications = journal()
    await materializerOver(notifications).materialize(
      view("profile-a", "incarnation-a", [{ accountCorrelationId: "opaque-account", modes: [{ envelopeId: "removed", decision: "unreviewed" }] }]),
    )

    const restarted = materializerOver(notifications)
    await restarted.materialize(view("profile-a", "incarnation-a", []))

    expect(notifications.resolved).toHaveLength(1)
    expect(notifications.projection().visible).toHaveLength(0)
  })

  it("reconciles authority replacement without leaving an obsolete episode", async () => {
    const notifications = journal()
    const materializer = materializerOver(notifications)
    await materializer.materialize(view("profile-a", "incarnation-a", [{ accountCorrelationId: "old-account", modes: [{ envelopeId: "old", decision: "unreviewed" }] }]))
    await materializer.materialize(view("profile-a", "incarnation-b", [{ accountCorrelationId: "current-account", modes: [{ envelopeId: "current", decision: "accepted" }] }]))
    await materializer.materialize(view("profile-a", "incarnation-b", [{ accountCorrelationId: "current-account", modes: [{ envelopeId: "new", decision: "unreviewed" }] }]))

    expect(notifications.resolved).toHaveLength(1)
    expect(notifications.raised).toHaveLength(2)
    expect(notifications.projection().visible).toHaveLength(1)
  })

  it("resolves a deleted profile episode from the catalog after restart", async () => {
    const notifications = journal()
    const deleted = view("profile-deleted", "incarnation-a", [{ accountCorrelationId: "deleted-account", modes: [{ envelopeId: "old", decision: "unreviewed" }] }])
    await materializerOver(notifications).materializeAuth(auth(deleted, ["profile-deleted"]))

    const restarted = materializerOver(notifications)
    const current = view("profile-current", "incarnation-b", [])
    await restarted.materializeAuth(auth(current, ["profile-current"]))

    expect(notifications.resolved).toHaveLength(1)
    expect(notifications.projection().visible).toHaveLength(0)
  })

  for (const hiddenState of ["dismissed", "expired"] as const) {
    it(`resolves ${hiddenState} obsolete authority episodes after restart`, async () => {
      const notifications = journal()
      const first = materializerOver(notifications)
      await first.materialize(view("profile-a", "incarnation-a", [{ accountCorrelationId: "old-account", modes: [{ envelopeId: "old", decision: "unreviewed" }] }]))
      const sourceId = notifications.raised[0]
      if (sourceId === undefined) throw new Error("expected raised source")
      notifications.hide(sourceId, hiddenState)

      await materializerOver(notifications).materialize(
        view("profile-a", "incarnation-b", [{ accountCorrelationId: "current-account", modes: [{ envelopeId: "current", decision: "accepted" }] }]),
      )

      expect(notifications.resolved).toEqual([sourceId])
    })

    it(`resolves ${hiddenState} deleted-profile episodes after restart`, async () => {
      const notifications = journal()
      const deleted = view("profile-deleted", "incarnation-a", [{ accountCorrelationId: "deleted-account", modes: [{ envelopeId: "old", decision: "unreviewed" }] }])
      await materializerOver(notifications).materializeAuth(auth(deleted, ["profile-deleted"]))
      const sourceId = notifications.raised[0]
      if (sourceId === undefined) throw new Error("expected raised source")
      notifications.hide(sourceId, hiddenState)

      const current = view("profile-current", "incarnation-b", [])
      await materializerOver(notifications).materializeAuth(auth(current, ["profile-current"]))

      expect(notifications.resolved).toEqual([sourceId])
    })
  }

  it("keeps the newest revision for both completion orders", async () => {
    const olderLastJournal = journal()
    const olderLast = materializerOver(olderLastJournal)
    await olderLast.materialize(view("profile-a", "incarnation-a", [{ accountCorrelationId: "account", modes: [{ envelopeId: "reviewed", decision: "accepted" }] }], 2))
    await olderLast.materialize(view("profile-a", "incarnation-a", [{ accountCorrelationId: "account", modes: [{ envelopeId: "stale", decision: "unreviewed" }] }], 1))

    const newerLastJournal = journal()
    const newerLast = materializerOver(newerLastJournal)
    await Promise.all([
      newerLast.materialize(view("profile-a", "incarnation-a", [{ accountCorrelationId: "account", modes: [{ envelopeId: "stale", decision: "unreviewed" }] }], 1)),
      newerLast.materialize(view("profile-a", "incarnation-a", [{ accountCorrelationId: "account", modes: [{ envelopeId: "reviewed", decision: "accepted" }] }], 2)),
    ])

    expect(olderLastJournal.raised).toHaveLength(0)
    expect(olderLastJournal.projection().visible).toHaveLength(0)
    expect(newerLastJournal.raised).toHaveLength(0)
    expect(newerLastJournal.projection().visible).toHaveLength(0)
  })

  it("does not let stale usage evidence resolve a newer review episode", async () => {
    const notifications = journal()
    const materializer = materializerOver(notifications)
    await materializer.materialize(view("profile-a", "incarnation-a", [{ accountCorrelationId: "account", modes: [{ envelopeId: "current", decision: "unreviewed" }] }], 1, 2))
    await materializer.materialize(view("profile-a", "incarnation-a", [{ accountCorrelationId: "account", modes: [{ envelopeId: "stale", decision: "accepted" }] }], 1, 1))

    expect(notifications.resolved).toHaveLength(0)
    expect(notifications.projection().visible).toHaveLength(1)
  })

  it("rejects a retired authority after its replacement becomes current", async () => {
    const notifications = journal()
    const materializer = materializerOver(notifications)

    await materializer.materialize(view("profile-a", "incarnation-a", [{ accountCorrelationId: "old-account", modes: [{ envelopeId: "old", decision: "unreviewed" }] }]))
    await materializer.materialize(view("profile-a", "incarnation-b", [{ accountCorrelationId: "current-account", modes: [{ envelopeId: "current", decision: "accepted" }] }]))
    await materializer.materialize(view("profile-a", "incarnation-a", [{ accountCorrelationId: "old-account", modes: [{ envelopeId: "stale", decision: "unreviewed" }] }], 2))

    expect(notifications.raised).toHaveLength(1)
    expect(notifications.resolved).toHaveLength(1)
    expect(notifications.projection().visible).toHaveLength(0)
  })

  it("states one episode for the first enableable unreviewed mode of an account", async () => {
    const notifications = journal()
    const materializer = materializerOver(notifications)

    await materializer.materialize(view("profile-a", "incarnation-a", [{
      accountCorrelationId: "account",
      modes: [
        { envelopeId: "first", decision: "accepted" },
        { envelopeId: "second", decision: "declined" },
        { envelopeId: "third", decision: "unreviewed" },
      ],
    }]))

    expect(notifications.raised).toHaveLength(1)
    expect(notifications.projection().visible[0]?.action).toEqual({ kind: "open-auth", providerId: "provider", accountCorrelationId: "account", envelopeId: "third" })
  })

  it("keeps separate project journals independent", async () => {
    const firstJournal = journal()
    const secondJournal = journal()
    const consent = view("profile-a", "incarnation-a", [{ accountCorrelationId: "opaque-account", modes: [{ envelopeId: "opaque-envelope", decision: "unreviewed" }] }])

    await materializerOver(firstJournal).materialize(consent)
    await materializerOver(secondJournal).materialize(consent)

    expect(firstJournal.raised).toEqual(secondJournal.raised)
    expect(firstJournal.raised).toHaveLength(1)
    expect(firstJournal.projection().visible).toHaveLength(1)
    expect(secondJournal.projection().visible).toHaveLength(1)
  })
  it("reconciles one auth publication once and materializes one episode per account", async () => {
    const notifications = journal()
    const materializer = materializerOver(notifications)
    const consent = view("profile-a", "incarnation-a", [
      { accountCorrelationId: "account-a", providerId: "provider-a", modes: [{ envelopeId: "a", decision: "unreviewed" }] },
      { accountCorrelationId: "account-b", providerId: "provider-b", modes: [{ envelopeId: "b", decision: "unreviewed" }] },
      { accountCorrelationId: "account-c", modes: [{ envelopeId: "c", decision: "unreviewed", positiveEvidence: false }] },
    ])

    await materializer.materializeAuth(auth(consent, ["profile-a"]))

    expect(notifications.raised).toHaveLength(2)
    expect(notifications.projection().visible.map((episode) => episode.action)).toEqual([
      { kind: "open-auth", providerId: "provider-a", accountCorrelationId: "account-a", envelopeId: "a" },
      { kind: "open-auth", providerId: "provider-b", accountCorrelationId: "account-b", envelopeId: "b" },
    ])
  })

  it("resolves only the account that no longer needs review and raises recurrence", async () => {
    const notifications = journal()
    const materializer = materializerOver(notifications)
    await materializer.materialize(view("profile-a", "incarnation-a", [
      { accountCorrelationId: "account-a", modes: [{ envelopeId: "a", decision: "unreviewed" }] },
      { accountCorrelationId: "account-b", modes: [{ envelopeId: "b", decision: "unreviewed" }] },
    ]))
    await materializer.materialize(view("profile-a", "incarnation-a", [
      { accountCorrelationId: "account-a", modes: [{ envelopeId: "a", decision: "accepted" }] },
      { accountCorrelationId: "account-b", modes: [{ envelopeId: "b", decision: "unreviewed" }] },
    ], 2))
    await materializer.materialize(view("profile-a", "incarnation-a", [
      { accountCorrelationId: "account-a", modes: [{ envelopeId: "a2", decision: "unreviewed" }] },
      { accountCorrelationId: "account-b", modes: [{ envelopeId: "b", decision: "unreviewed" }] },
    ], 3))

    expect(notifications.resolved).toHaveLength(1)
    expect(notifications.raised).toHaveLength(3)
    expect(notifications.projection().visible).toHaveLength(2)
  })

  it("materializes later detection from the published session profile view", async () => {
    const defaults = view("profile-a", "authority-a", [])
    const session = view("profile-b", "authority-b", [{ accountCorrelationId: "session-account", modes: [{ envelopeId: "later-b", decision: "unreviewed" }] }])
    const materialized: SubscriptionSpendConsentView[] = []
    const event = {
      type: "patch",
      patch: {
        cursor: { scope: "session", sessionId: "foreground", domain: "auth" },
        position: 2,
        prevPosition: 1,
        payload: { kind: "auth.changed", auth: { providers: [], warnings: [], profile: { id: "profile-b", displayName: "B", source: "sticky", availableProfiles: [] }, subscriptionSpendConsent: session } },
      },
    } as const

    await materializeSubscriptionSpendConsentAuthChange({ materializeAuth: async (publishedAuth) => { materialized.push(publishedAuth.subscriptionSpendConsent) } }, event)

    expect(materialized).toEqual([session])
    expect(materialized).not.toContain(defaults)
  })

})
