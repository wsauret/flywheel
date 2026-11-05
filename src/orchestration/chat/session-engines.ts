import { Effect, Exit, Scope } from "effect"
import { Log } from "../../infra/log.js"
import { recordBackgroundFailure } from "../../infra/operation-log.js"
import type { AgentOptions } from "../agent-runtime/types.js"
import type { Claim, ConversationMessage, ProviderDemand } from "../agent-runtime/llm/types.js"
import type { RequestPreparer } from "../agent-runtime/request-preparation.js"
import { openProviderSession, type HeldProviderSession, type ProviderSession } from "../agent-runtime/provider-runtime-cache.js"
import type { ResolvedRole, RoleResolver } from "../config/roles.js"

const log = Log.create({ service: "session-engines" })

/** Why the session plans its engines: a client began to show it, its role assignments changed, the environment that
 *  serves its requests changed (credentials, model listing, provider connections), its turn ended, which is where a
 *  chat model switch that the turn could not take applies, or a provider asked it to plan again
 *  (`ProviderDemand.stale`). */
type PlanReason = "shown" | "role-change" | "serving-change" | "turn-end" | "stale"

type PrestartOptions = AgentOptions & { readonly providerSession: ProviderSession }

/** The chat's next send for its pre-start: its options, and the read of its history, which runs only when the
 *  pre-start prepares a request. */
interface ChatPrestart {
  readonly options: PrestartOptions
  readonly readHistory: () => Promise<readonly ConversationMessage[]>
}

export interface SessionEnginesDeps {
  readonly sessionId: string
  /** Prepares the request of a pre-start as the session's other runs prepare theirs. */
  readonly prepareRequest: RequestPreparer
  readonly resolveRoles: RoleResolver
  /** The chat's next send, on `provider`, with a conversation that writes nothing. */
  readonly chatOptions: (provider: ProviderSession) => Promise<ChatPrestart>
  /** The options of one call of the chat tree's shared host on `role`'s selection, on `provider`. */
  readonly hostOptions: (role: ResolvedRole, provider: ProviderSession) => PrestartOptions
}

/**
 * The engine demand of one chat session, which lives while a client shows the session (ARCH-PROVIDERS-070,
 * ARCH-PROVIDERS-068): the chat's next request, and one call of the chat tree's shared host for each distinct
 * selection of the session's roles, the chat's included, because a general child and a side question run on the
 * chat's selection through the host. The session states its demand and holds the claims that the providers return;
 * which engines run for it is the providers' own decision.
 *
 * Whether a client shows the session is the only thing that plans: a runner that exists for work that no client shows
 * plans nothing. A plan prepares a request as a send does and sends nothing (`RequestPreparer`), and hands it to the
 * serving client (`LLMClient.anticipate`), whose claim the session holds until a newer plan replaces it or the session
 * is hidden; the newer claim is installed before the older one is released. The session plans every selection when
 * it is shown, when its role assignments change the chat's selection or the set of host selections, when the
 * environment that serves its requests changes, because a send then resolves a new client that an older plan's
 * engine does not serve, and when a provider asks it to (`ProviderDemand.stale`), which plans once for any number of
 * asks that come before that plan starts. At a turn end it plans the chat alone, because only the chat's request
 * changed. The chat's pre-start runs only while no turn runs and stops when a turn starts, so it never replaces the
 * client that a turn uses; a model switch thus applies at the turn's end, which also ends the engine of the earlier
 * model. A plan that resolves no chat role releases the chat's claim and client in the
 * same way: at once while no turn runs, else at the turn's end.
 *
 * Each show has its own demand (`ProviderDemand`), which the show's first plan creates. When the last client releases
 * the session, it releases every claim, then ends the show's demand, and ends the chat's client at once, or when the
 * running turn ends. Work that runs holds what it uses until it ends.
 */
export interface SessionEngines {
  /** The chat's provider runtime, which every run of the chat takes, so the engine that a pre-start started serves
   *  the chat's next send. */
  readonly chat: ProviderSession
  /** A client shows the session (`true`), also again at a reattach, or the last client released it (`false`). */
  setShown(shown: boolean): void
  /** The session's role assignments may have changed. */
  rolesChanged(): void
  /** The environment that serves the session's requests was refreshed. */
  servingChanged(): void
  /** The chat's turn started, so it uses the chat's client until it ends: a chat pre-start that runs stops before it
   *  can replace the turn's client. */
  turnStarted(): void
  /** The chat's turn ended: it parked for the person or it settled, by completion, failure, or a stop at its
   *  startup. The first call after `turnStarted` counts; a later one, such as the settle of a turn that parked
   *  before, does nothing. */
  turnEnded(): void
  /** Stops planning, ends a pre-start that runs, and releases everything that the session holds; an engine that
   *  serves an open request ends when that request ends. */
  close(): Promise<void>
}

/** One selection of a role: what decides the request that the role's runs send. */
function roleSelection(role: ResolvedRole): string {
  return JSON.stringify([role.model, role.effort, role.providerOptions ?? null])
}

/** The provider runtime of one distinct selection of the session's host calls, and the claim of its newest plan. */
interface HostSelection {
  readonly provider: HeldProviderSession
  claim: Claim | undefined
}

/** What a pre-start ended with: the claim of its anticipation, if any, or `stopped` when its owner stopped it, which
 *  keeps the claim that the session held. */
type PrestartResult = { readonly claim: Claim | undefined } | "stopped"

export function createSessionEngines(deps: SessionEnginesDeps): SessionEngines {
  const { sessionId } = deps
  let shown = false
  let closed = false
  let turnOpen = false
  let running: { readonly target: "chat" | "host"; readonly controller: AbortController } | undefined
  /** The session's planning and releases, one at a time. */
  let work: Promise<void> = Promise.resolve()
  /** A plan for a provider's ask is queued and has not started. */
  let staleQueued = false

  /** Runs `task` and records its failure, so a failed step never stops the steps after it. */
  const contained = (operation: string, task: () => Promise<void>): Promise<void> =>
    task().then(() => undefined, (error: unknown) => { recordBackgroundFailure(log, operation, { sessionId }, error) })
  const enqueue = (operation: string, task: () => Promise<void>): void => {
    work = work.then(() => contained(operation, task))
  }
  const active = (): boolean => shown && !closed

  /** The demand of the show that runs now, which the first plan of a show creates and the hide closes. A client that a
   *  turn kept across a hide and the next show reports to the demand that it was built with; its ask still plans this
   *  session, which is the one it asks about. */
  let demand: { readonly demand: ProviderDemand; readonly scope: Scope.Closeable } | undefined
  const currentDemand = (): ProviderDemand | undefined => demand?.demand
  const openDemand = (): void => {
    if (demand !== undefined) return
    const scope = Scope.makeUnsafe("sequential")
    demand = {
      scope,
      demand: {
        scope,
        stale() {
          if (staleQueued || !active()) return
          staleQueued = true
          plan("stale")
        },
      },
    }
  }
  const closeDemand = async (): Promise<void> => {
    const closing = demand
    demand = undefined
    if (closing !== undefined) await Effect.runPromise(Scope.close(closing.scope, Exit.void))
  }
  const chat = openProviderSession(currentDemand)
  let chatClaim: Claim | undefined
  /** The chat selection the session last planned for, which a role-change plan compares. */
  let chatSelection: string | undefined
  const hosts = new Map<string, HostSelection>()

  /** Runs one pre-start: prepares its request and hands it to the serving client. A pre-start that its owner stopped
   *  ends quietly; one that failed rejects. */
  const prestart = async (target: "chat" | "host", reason: PlanReason, options: PrestartOptions, readHistory?: ChatPrestart["readHistory"]): Promise<PrestartResult> => {
    const startedAt = performance.now()
    const controller = new AbortController()
    running = { target, controller }
    const record = (outcome: "claimed" | "unclaimed" | "declined" | "stopped", nextMessage?: "unknown"): void => {
      log.debug("session engine planned", { sessionId, target, reason, outcome, ...(nextMessage ? { nextMessage } : {}), durationMs: Math.round(performance.now() - startedAt) })
    }
    try {
      const prepared = await deps.prepareRequest(options, { signal: controller.signal, ...(readHistory === undefined ? {} : { readHistory }) })
      // A stopped pre-start starts nothing, also when its stop came after its preparation settled.
      controller.signal.throwIfAborted()
      if (prepared === undefined) {
        record("declined")
        return { claim: undefined }
      }
      const claim = await prepared.candidate.client.anticipate?.(prepared.request)
      record(claim === undefined ? "unclaimed" : "claimed", prepared.nextMessage)
      return { claim }
    } catch (error) {
      // The owner stopped it: a turn started, no client shows the session, or the session closed.
      if (!controller.signal.aborted) throw error
      record("stopped")
      return "stopped"
    } finally {
      running = undefined
    }
  }

  /** Plans the chat's next request, or, when no chat role resolves (such as on an auth profile with no models),
   *  releases the chat's claim and client, because nothing wants its engine. A running turn keeps both until its end,
   *  whose plan releases them. */
  const planChat = async (reason: PlanReason, role: ResolvedRole | undefined): Promise<void> => {
    // Set before the plan can be put off, stopped, or fail, as the hosts' selections are: the turn-end plan always
    // plans the chat, and a failed pre-start retries at the next plan of another reason.
    chatSelection = role === undefined ? undefined : roleSelection(role)
    if (turnOpen) return
    if (role === undefined) {
      const previous = chatClaim
      chatClaim = undefined
      await previous?.release()
      await chat.session.cache.release()
      // INFO: one record when a chat claim ends because no chat role resolves; later plans without a role hold none.
      if (previous !== undefined) log.info("session chat engine released", { sessionId, reason })
      return
    }
    const next = await deps.chatOptions(chat.session)
    if (!active() || turnOpen) return
    const result = await prestart("chat", reason, next.options, next.readHistory)
    if (result === "stopped") return
    const previous = chatClaim
    chatClaim = result.claim
    await previous?.release()
  }

  /** Whether `roles` give the chat and the hosts the selections that the session last planned for. */
  const plannedFor = (roles: ReadonlyMap<string, ResolvedRole>): boolean => {
    const chatRole = roles.get("chat")
    if ((chatRole === undefined ? undefined : roleSelection(chatRole)) !== chatSelection) return false
    const keys = new Set([...roles.values()].map(roleSelection))
    return keys.size === hosts.size && [...keys].every((key) => hosts.has(key))
  }

  const releaseSelection = async (selection: HostSelection): Promise<void> => {
    await selection.claim?.release()
    await selection.provider.close()
  }

  const planHosts = async (reason: PlanReason, roles: Iterable<ResolvedRole>): Promise<void> => {
    const wanted = new Map<string, ResolvedRole>()
    for (const role of roles) if (!wanted.has(roleSelection(role))) wanted.set(roleSelection(role), role)
    // New selections plan before old ones go, so a host that both claim stays open across the change.
    for (const [key, role] of wanted) {
      if (!active()) return
      const selection = hosts.get(key) ?? { provider: openProviderSession(currentDemand), claim: undefined }
      hosts.set(key, selection)
      await contained("plan session host", async () => {
        const result = await prestart("host", reason, deps.hostOptions(role, selection.provider.session))
        if (result === "stopped") return
        const previous = selection.claim
        selection.claim = result.claim
        await previous?.release()
      })
    }
    for (const [key, selection] of hosts) {
      if (wanted.has(key)) continue
      hosts.delete(key)
      await releaseSelection(selection)
    }
  }

  function plan(reason: PlanReason): void {
    if (!active()) return
    enqueue("plan session engines", async () => {
      if (reason === "stale") staleQueued = false
      if (!active()) return
      openDemand()
      const roles = await deps.resolveRoles()
      if (!active()) return
      // Every send and turn end changes the session's metadata, which notices a role change, so only a changed
      // selection plans.
      if (reason === "role-change" && plannedFor(roles)) return
      await contained("plan chat engine", () => planChat(reason, roles.get("chat")))
      if (reason !== "turn-end") await planHosts(reason, roles.values())
    })
  }

  /** Releases every claim that the session holds and every host selection's provider runtime. */
  const releaseClaims = async (): Promise<number> => {
    const released = [...hosts.values()]
    hosts.clear()
    const claim = chatClaim
    chatClaim = undefined
    chatSelection = undefined
    await Promise.all([claim?.release(), ...released.map(releaseSelection)])
    return released.length
  }

  const releaseChat = (): void => {
    enqueue("release chat engine", async () => {
      if (shown || turnOpen) return
      await chat.session.cache.release()
    })
  }

  const hide = (): void => {
    shown = false
    running?.controller.abort()
    enqueue("release session engines", async () => {
      if (shown) return
      const released = await releaseClaims()
      await closeDemand()
      // The release of the chat's claim stops its idle engine. A turn's engine that no claim holds, such as the one
      // that took the show's reservation, ends with the chat's client, now or when the running turn ends.
      const afterTurn = turnOpen
      if (!afterTurn) await chat.session.cache.release()
      // INFO: one record each time the last client releases the session.
      log.info("session engines released", { sessionId, hosts: released, chat: afterTurn ? "after-turn" : "now" })
    })
  }

  return {
    chat: chat.session,
    setShown(next) {
      if (closed) return
      if (!next) { if (shown) hide(); return }
      shown = true
      plan("shown")
    },
    rolesChanged: () => { plan("role-change") },
    servingChanged: () => { plan("serving-change") },
    turnStarted() {
      turnOpen = true
      if (running?.target === "chat") running.controller.abort()
    },
    turnEnded() {
      if (closed || !turnOpen) return
      turnOpen = false
      if (shown) plan("turn-end")
      else releaseChat()
    },
    async close() {
      closed = true
      running?.controller.abort()
      await work
      const released = await releaseClaims()
      await chat.close()
      await closeDemand()
      // INFO: one record when the session's runner ends.
      log.info("session engines closed", { sessionId, hosts: released })
    },
  }
}
