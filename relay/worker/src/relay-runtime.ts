import { DurableObject } from "cloudflare:workers"

import {
  claimedRelayProtocolVersion,
  decodeChannelAcceptFrame,
  decodeDeviceFrame,
  decodeJsonFrame,
  decodeRuntimeControlFrame,
  RELAY_PING,
  RELAY_PONG,
  RELAY_PROJECT_START_TIMEOUT_MS,
  RELAY_PROTOCOL_VERSION,
  RELAY_SILENCE_DEADLINE_MS,
  statedSilenceDeadlineMs,
  toBase64Url,
  type Placement,
  type PresencePlacement,
  type RelayControlFrame,
  type RelayDeviceFrame,
  type RelayRejectReason,
} from "../../../src/protocol/modules/remote/relay-protocol.js"
import { admitDevice, admitPairing, admitRuntime, presencePlacement, RateLimiter, servedPlacements, servingAnnouncement, silentAt, type PairingWindowRecord, type PlacementAnnouncement } from "./admission.js"
import { ClientAssetServer } from "./client-assets.js"
import { bytesOn, dailyBudgetBytes, relayAdmission, utcDay, type DayBytes } from "./operator-limits.js"

/** One runtime identity's presence at the relay.
 *
 *  Every socket for a runtime id lands in this object: the control channel of
 *  each placement, every device watching presence or attached to a placement,
 *  and every data channel a runtime dialed. The object knows which placements
 *  are served and by what (a running runtime, or the machine's remote host
 *  that can start one), which device ids may attach, which pairing window is
 *  open, and which two sockets form a channel. It stores no user, session, transcript,
 *  or subscription, and it parses no frame after admission: a binary frame on
 *  a channel is copied to its peer and nothing else happens to it. Whatever
 *  ends one side of a channel, a close, an error, or silence past the
 *  heartbeat the socket stated, closes the other side with the reason, and
 *  so does the machine's word that its side ended (`channel.ended`), because
 *  the edge can drop the machine's socket without this object hearing a
 *  close. A device waiting for its channel waits on its placement, not on
 *  one control socket: when another socket comes to serve the placement, as a machine's
 *  fresh control socket does after its old one went silent, the device's
 *  `open` moves there.
 *
 *  Sockets are hibernatable, so this object may be evicted between messages.
 *  Everything a socket stands for rides in that socket's attachment, which
 *  hibernation keeps without a storage call: a device's `open` waiting for
 *  its channel lives on the device socket, and a pairing window on the
 *  control socket that announced it last, so each ends with its socket. Storage
 *  holds only what must outlive every socket: the device allowlist, which
 *  presence admits by while no machine is attached, the client cache, and
 *  the runtime's daily byte count, which a channel adds to when it ends.
 *  Every storage write is a moment in which a storage fault resets this
 *  object and ends every socket of the machine at once, so the object
 *  writes the allowlist only when it changes, and arms its sweep only while
 *  a device is connected, the only time a dead socket can keep a person
 *  waiting.
 *
 *  The one exception is a client file in transit: the object also serves the
 *  web client each machine announces (`client-assets.ts`), and a transfer
 *  lives in memory while the phone's request keeps the object awake. */

/** Cloudflare passes single frames up to 32 MiB; the ceiling here leaves room
 *  under it so a runaway frame closes with a typed code instead of a platform
 *  surprise. The largest real body the store has produced is 4.4 MB. */
const FRAME_CEILING_BYTES = 16 * 1024 * 1024
/** Concurrent device channels one runtime id may hold. */
const MAX_CHANNELS = 32
/** Unclaimed `open` tickets expire so a runtime that never dialed cannot pin a device forever. */
const PENDING_CHANNEL_TTL_MS = 30_000

/** The daily byte count of every channel that ended, or that carried
 *  `FOLD_BYTES` since it last added to the count. A channel adds what it
 *  carries here when it ends, and meanwhile keeps it in its attachment,
 *  which hibernation keeps without a storage call; so the count costs one
 *  write per channel, and an eviction that ends sockets without a close
 *  loses at most `FOLD_BYTES` of each. */
const PUMPED_KEY = "pumped"
const FOLD_BYTES = 64 * 1024 * 1024

/** `acceptedAt` stands in for the heartbeat timestamp until the first ping,
 *  so a socket is judged live for one deadline after it arrives and by what
 *  it sends from then on. `deadlineMs` is the silence the socket's stated
 *  heartbeat allows (`relay-protocol.ts`); a runtime or device socket that
 *  stated none is judged by the presence deadline. Channel sockets carry the
 *  runtime's side of a data channel and close when their device peer closes;
 *  one that stated a heartbeat also closes when it falls silent. */
type Attachment = RuntimeAttachment | DeviceAttachment | ChannelAttachment

interface AdmittedSocket {
  readonly nonce: string
  readonly socketId: string
  readonly acceptedAt: number
  readonly deadlineMs?: number
}

/** A control socket. `windows` are the pairing windows it announced and has
 *  not closed or used; only it holds their secret. A machine announces its
 *  open window again on each attach, so the newest announcer holds a window
 *  and every other socket gives it up. */
type RuntimeAttachment = AdmittedSocket & { readonly role: "runtime"; placement?: Placement; windows?: readonly PairingWindow[] }

interface PairingWindow {
  readonly windowId: string
  readonly expiresAt: number
}

/** A device socket, through the stages of its one use: the challenge,
 *  watching presence, waiting for its channel, and attached to it. */
type DeviceAttachment = AdmittedSocket & { readonly role: "device" } & DeviceStage
type DeviceStage =
  | { readonly state: "handshake" }
  | { readonly state: "presence" }
  | { readonly state: "waiting"; readonly open: PendingOpen }
  | { readonly state: "attached"; readonly channelId: string }
type WaitingDevice = Extract<DeviceAttachment, { state: "waiting" }>

/** `pumped` is what the channel carried today and has not yet added to the
 *  stored daily count (`PUMPED_KEY`). */
type ChannelAttachment = { readonly role: "channel"; readonly runtimeId: string; readonly acceptedAt: number; readonly deadlineMs?: number; channelId?: string; deviceSocketId?: string; pumped?: DayBytes }

/** How long a socket may stay silent before the sweep closes it, or undefined
 *  for a data channel held only by its device. */
function silenceDeadlineMs(attachment: Attachment): number | undefined {
  return attachment.deadlineMs ?? (attachment.role === "channel" ? undefined : RELAY_SILENCE_DEADLINE_MS)
}

/** The `open` a waiting device's channel was told by, until the runtime's
 *  channel socket presents its ticket. */
interface PendingOpen {
  readonly channelId: string
  readonly ticket: string
  /** The control socket told to dial; its account's machine control may also report a wake failure. */
  readonly runtimeSocketId: string
  readonly openedAt: number
  readonly starting?: true
  /** The placement and device of a device's channel, which let the `open`
   *  follow the placement to whichever control socket serves it. A pairing
   *  channel has none and stays with the socket that announced its window,
   *  the one that holds the window's secret. */
  readonly device?: { readonly placementId: string; readonly deviceId: string }
}

/** When an `open` the runtime never claimed stops holding its device. */
function expiresAt(open: PendingOpen): number {
  return open.openedAt + (open.starting ? RELAY_PROJECT_START_TIMEOUT_MS : PENDING_CHANNEL_TTL_MS)
}

/** A device attachment at a new stage, written back to its socket. */
function moveDevice(ws: WebSocket, attachment: DeviceAttachment, stage: DeviceStage): void {
  const { role, nonce, socketId, acceptedAt, deadlineMs } = attachment
  const next: DeviceAttachment = { role, nonce, socketId, acceptedAt, ...(deadlineMs === undefined ? {} : { deadlineMs }), ...stage }
  ws.serializeAttachment(next)
}

function earliest(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right
  return right === undefined ? left : Math.min(left, right)
}

/** The rows relays deployed before 2026-10-22 kept for waiting opens and
 *  pairing windows. Remove after 2027-01-22, with `dropLegacyRows`. */
const LEGACY_PREFIXES = ["pending:", "window:"] as const

function tagFor(attachment: Attachment): string[] {
  switch (attachment.role) {
    case "runtime":
      return ["runtime", `rt:${attachment.socketId}`]
    case "device":
      return ["device", `dev:${attachment.socketId}`]
    case "channel":
      return ["channel"]
  }
}

/** Reads a socket's attachment. The attachment is this object's own writing,
 *  so a shape it does not recognize is a socket it never admitted. */
function attachmentOf(ws: WebSocket): Attachment | undefined {
  const value: unknown = ws.deserializeAttachment()
  if (typeof value !== "object" || value === null || !("role" in value)) return undefined
  const role = value.role
  if (role === "runtime" || role === "device" || role === "channel") return value as Attachment // oxlint-disable-line typescript/consistent-type-assertions -- boundary: the attachment is this object's own serialized record
  return undefined
}

function randomId(bytes = 12): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)))
}

/** Closes a socket the platform may already have torn down. A close the
 *  socket refuses proves it is gone, which is the outcome the caller wanted,
 *  and must never abort the sweep or release that asked for it. */
function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason)
  } catch {
    // Already closed.
  }
}

/** @externalHost Cloudflare instantiates the Durable Object class by its exported name. */
export class RelayRuntime extends DurableObject<Env> {
  private readonly pairingAttempts = new RateLimiter(10, 60_000)
  private readonly attachAttempts = new RateLimiter(60, 60_000)
  private readonly clientAssets = new ClientAssetServer(this.ctx.storage, () => this.liveAnnouncements(), (ws, frame) => this.send(ws, frame))
  /** When each socket last delivered a frame to this object. A ping waits
   *  behind every byte already queued on its socket, so a machine sending a
   *  large body over a slow link pings late while its frames keep arriving,
   *  and those frames are proof the link works. Memory is enough: a socket
   *  delivering frames keeps the object awake, and one that hibernated has
   *  delivered none for longer than the platform's idle window, so its pings
   *  alone judge it. */
  private readonly heardAt = new WeakMap<WebSocket, number>()
  /** Whether this instance has deleted the rows an earlier relay kept. */
  private legacyRowsDropped = false
  /** Today's pumped bytes: `stored` as `PUMPED_KEY` holds it, and `total`
   *  with what every open channel carries besides. Read once per instance. */
  private pumped: { readonly day: string; stored: number; total: number } | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // The platform answers a ping on any of this object's sockets without
    // waking it, and records when it last did so per socket; that record is
    // how a hibernating object still knows which sockets are alive.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(RELAY_PING, RELAY_PONG))
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const [, role, runtimeId, ...rest] = url.pathname.split("/")
    if (role === "client") return this.clientAssets.serve(request, rest)
    if (runtimeId === undefined || (role !== "runtime" && role !== "device" && role !== "channel")) return new Response("not found", { status: 404 })
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("websocket only", { status: 426 })
    const source = request.headers.get("CF-Connecting-IP") ?? "unknown"
    if (role !== "runtime" && !this.attachAttempts.admit(`${source}`, Date.now())) return new Response("rate limited", { status: 429 })

    const pair = new WebSocketPair()
    const server = pair[1]
    const now = Date.now()
    const stated = statedSilenceDeadlineMs(url)
    const heartbeat = stated === undefined ? {} : { deadlineMs: stated }
    const attachment: Attachment = role === "runtime"
      ? { role, nonce: randomId(32), socketId: randomId(), acceptedAt: now, ...heartbeat }
      : role === "device"
        ? { role, nonce: randomId(32), socketId: randomId(), acceptedAt: now, ...heartbeat, state: "handshake" }
        : { role, runtimeId, acceptedAt: now, ...heartbeat }
    this.ctx.acceptWebSocket(server, tagFor(attachment))
    server.serializeAttachment(attachment)
    if (attachment.role !== "channel") this.send(server, { type: "challenge", nonce: attachment.nonce })
    await this.armSweep()
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.heardAt.set(ws, Date.now())
    const attachment = attachmentOf(ws)
    if (!attachment) return ws.close(1011, "no attachment")
    if (typeof message !== "string") {
      if (message.byteLength > FRAME_CEILING_BYTES) return ws.close(1009, "frame exceeds the relay ceiling")
      return this.pump(ws, attachment, message)
    }
    try {
      switch (attachment.role) {
        case "runtime":
          return await this.onRuntimeFrame(ws, attachment, message)
        case "device":
          return await this.onDeviceFrame(ws, attachment, message)
        case "channel":
          return await this.onChannelFrame(ws, attachment, message)
      }
    } catch {
      this.reject(ws, "malformed")
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    closeQuietly(ws, code === 1005 || code === 1006 ? 1000 : code, reason)
    const attachment = attachmentOf(ws)
    if (attachment) await this.release(ws, attachment, code, reason)
  }

  /** Forgets what a socket stood for. Idempotent, because the stale sweep
   *  releases a socket it closes itself and the platform may report that
   *  close again later. `code` and `reason` are the close this socket saw;
   *  they travel to the channel peer so the far end can tell a phone that
   *  hung up from a phone the relay swept. */
  private async release(ws: WebSocket, attachment: Attachment, code: number, reason: string): Promise<void> {
    if (attachment.role === "channel") await this.foldChannel(ws, attachment)
    if (attachment.role === "runtime") this.clientAssets.machineLeft(attachment.socketId)
    if (attachment.role === "runtime" && attachment.placement !== undefined) {
      // A placement is what its live sockets say it is, and its pairing
      // windows ride on the socket that announced them, so a socket leaving
      // needs no record cleared: presence re-folds without it.
      await this.broadcastPresence()
      this.followPlacements()
      return
    }
    // Whichever side of a channel closes, the other side follows. The close
    // code a socket may send is 1000 or its own 4xxx range, so the peer's
    // code rides in the reason text instead, which the platform caps at 123
    // bytes.
    const peer = this.peerOf(attachment)
    if (peer) closeQuietly(peer, 1000, `peer closed ${code}${reason ? `: ${reason}` : ""}`.slice(0, 123))
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, "error", false)
  }

  // ---- runtime control channel ------------------------------------------------

  private async onRuntimeFrame(ws: WebSocket, attachment: Extract<Attachment, { role: "runtime" }>, message: string): Promise<void> {
    // A runtime on another build fails the strict decode below, and the
    // catch-all would call that malformed. Its version claim is readable
    // whatever shape the rest of its attach frame takes, so it is refused by
    // name and knows to stop retrying.
    const value: unknown = JSON.parse(message)
    const claimed = claimedRelayProtocolVersion(value)
    if (claimed !== undefined && claimed !== RELAY_PROTOCOL_VERSION) return this.reject(ws, "protocol_version")
    const frame = decodeRuntimeControlFrame(value)
    if (frame.type === "ping") return ws.send(RELAY_PONG)
    const runtimeId = this.ctx.id.name ?? ""
    if (frame.type === "attach") {
      if (!(await this.admitsRuntimes())) return this.reject(ws, "admission_closed")
      const verdict = await admitRuntime(frame, attachment.nonce, runtimeId)
      if (verdict !== "admitted") return this.reject(ws, verdict)
      attachment.placement = frame.placement
      ws.serializeAttachment(attachment)
      await this.storeAllowlist(frame.devices)
      this.send(ws, { type: "attached" })
      await this.broadcastPresence()
      this.followPlacements()
      await this.dropLegacyRows()
      return
    }
    if (attachment.placement === undefined) return this.reject(ws, "malformed")
    switch (frame.type) {
      case "devices":
        return this.storeAllowlist(frame.devices)
      case "pairing.open": {
        // Windows the machine let lapse go as it opens the next.
        this.withdrawWindow(frame.windowId, attachment.socketId)
        const now = Date.now()
        attachment.windows = [...(attachment.windows ?? []).filter((window) => window.windowId !== frame.windowId && window.expiresAt > now), { windowId: frame.windowId, expiresAt: frame.expiresAt }]
        ws.serializeAttachment(attachment)
        return
      }
      case "pairing.close":
        this.withdrawWindow(frame.windowId)
        return
      case "asset.head":
        return this.clientAssets.started(frame.requestId, attachment.socketId)
      case "asset.missing":
        return this.clientAssets.missing(frame.requestId, attachment.socketId)
      case "asset.end":
        return await this.clientAssets.ended(frame.requestId, attachment.socketId)
      case "channel.ended": {
        // The machine saw its side of the channel end with no close
        // handshake. Its socket here is dead whether or not a close arrives,
        // so the device is closed now, while it can still dial again.
        const channel = this.channelSocket(frame.channelId)
        if (channel) {
          closeQuietly(channel.ws, 1011, "the machine's side ended")
          await this.release(channel.ws, channel.attachment, 1006, "the machine's side ended")
          return
        }
        // Its side can also end before this object read its accept, and the
        // device then waits on a ticket no live socket will present.
        const waiting = this.waitingDevice(frame.channelId)
        if (waiting) await this.reopenChannel(waiting.ws, waiting.attachment)
        return
      }
      case "decline": {
        // The wake socket carries a later refusal until presence reports live.
        const waiting = this.waitingDevice(frame.channelId)
        if (!waiting) return
        // The machine control shares this runtime identity and survives the
        // dormant control's handoff. Only it may settle another control's wake.
        const machineFailure = frame.reason === "start_failed" && attachment.placement.id === runtimeId
        if (waiting.attachment.open.runtimeSocketId !== attachment.socketId && !machineFailure) return
        if (frame.reason === "starting") {
          moveDevice(waiting.ws, waiting.attachment, { state: "waiting", open: { ...waiting.attachment.open, starting: true } })
          this.send(waiting.ws, { type: "rejected", reason: "runtime_starting" })
        } else {
          // Closing the device ends its wait with it.
          this.reject(waiting.ws, "runtime_unavailable")
        }
        return
      }
    }
  }

  // ---- device socket ------------------------------------------------------------

  private async onDeviceFrame(ws: WebSocket, attachment: Extract<Attachment, { role: "device" }>, message: string): Promise<void> {
    const frame = decodeJsonFrame(decodeDeviceFrame, message)
    if (frame.type === "ping") return ws.send(RELAY_PONG)
    if (attachment.state !== "handshake") return this.reject(ws, "malformed")
    const runtimeId = this.ctx.id.name ?? ""
    const placements = await this.placements()
    const online = new Set(placements.map((placement) => placement.id))
    if (frame.type === "pair") {
      if (!this.pairingAttempts.admit(runtimeId, Date.now())) return this.reject(ws, "rate_limited")
      const window = this.pairingWindow(frame.windowId)
      const verdict = admitPairing(frame, { expectedRuntimeId: runtimeId, window, now: Date.now(), placementsOnline: online })
      if (verdict !== "admitted" || !window) return this.reject(ws, verdict === "admitted" ? "pairing_window_closed" : verdict)
      // One channel per window: the window closes the moment it is used, and
      // it opens on the socket that announced it, which is the one holding
      // the secret.
      this.withdrawWindow(frame.windowId)
      return this.openChannel(ws, attachment, { ws: window.ws, socketId: window.socketId }, { type: "open", channelId: "", ticket: "", kind: "pairing", windowId: frame.windowId }, undefined)
    }
    const allowlist = new Set(await this.ctx.storage.get<readonly string[]>("devices"))
    const verdict = await admitDevice(frame, { expectedRuntimeId: runtimeId, nonce: attachment.nonce, allowlist, placementsOnline: online })
    if (verdict !== "admitted") return this.reject(ws, verdict)
    if (frame.type === "presence") {
      moveDevice(ws, attachment, { state: "presence" })
      this.send(ws, { type: "presence", placements })
      return
    }
    if ((await this.pumpedToday()).total >= dailyBudgetBytes(this.env.RELAY_DAILY_GIB)) return this.reject(ws, "daily_budget")
    if ((await this.channelCount()) >= MAX_CHANNELS) return this.reject(ws, "channel_limit")
    return this.openChannel(ws, attachment, this.runtimeSocket(frame.placementId), { type: "open", channelId: "", ticket: "", kind: "device", deviceId: frame.deviceId }, { placementId: frame.placementId, deviceId: frame.deviceId })
  }

  /** Tells the placement to dial a channel for this device and parks the
   *  device until the runtime's channel socket presents the ticket. */
  private async openChannel(ws: WebSocket, attachment: DeviceAttachment, runtime: { readonly ws: WebSocket; readonly socketId: string } | undefined, open: Extract<RelayControlFrame, { type: "open" }>, device: PendingOpen["device"]): Promise<void> {
    if (!runtime) return this.reject(ws, "runtime_offline")
    const pending: PendingOpen = { channelId: randomId(), ticket: randomId(16), runtimeSocketId: runtime.socketId, openedAt: Date.now(), ...(device === undefined ? {} : { device }) }
    moveDevice(ws, attachment, { state: "waiting", open: pending })
    this.send(runtime.ws, { ...open, channelId: pending.channelId, ticket: pending.ticket })
    await this.scheduleAlarm(expiresAt(pending))
  }

  /** Moves each parked device's `open` to the control socket that serves its
   *  placement now, when that is no longer the one first told. Runs whenever
   *  the serving sockets change. A machine whose whole link died leaves its
   *  control socket counted live until the sweep, so a device dialing again
   *  meanwhile is told to that dead socket; the machine's fresh control
   *  socket takes the `open` the moment it attaches, and the device attaches
   *  without waiting out its ticket. The ticket and its expiry stay as they
   *  were, and only the socket told last may decline. Should both sockets
   *  dial, the first to present the ticket gets the channel and the other is
   *  refused as an unknown channel. */
  private followPlacements(): void {
    for (const ws of this.ctx.getWebSockets("device")) {
      const attachment = attachmentOf(ws)
      if (ws.readyState !== WebSocket.OPEN || attachment?.role !== "device" || attachment.state !== "waiting") continue
      const { open } = attachment
      if (open.device === undefined) continue
      const serving = this.runtimeSocket(open.device.placementId)
      if (serving === undefined || serving.socketId === open.runtimeSocketId) continue
      moveDevice(ws, attachment, { state: "waiting", open: { ...open, runtimeSocketId: serving.socketId } })
      this.send(serving.ws, { type: "open", channelId: open.channelId, ticket: open.ticket, kind: "device", deviceId: open.device.deviceId })
    }
  }

  /** Gives a device whose channel's machine side ended before it was
   *  accepted a new channel id and ticket, told to the control socket that
   *  serves its placement now. The old id is forgotten, so an accept for it
   *  that arrives late, from the dead socket, is refused as an unknown
   *  channel and never joins the device to that socket. A pairing channel
   *  belongs to the window its dead socket used up, so its device is refused
   *  and pairs again. */
  private async reopenChannel(ws: WebSocket, attachment: WaitingDevice): Promise<void> {
    const { device } = attachment.open
    if (device === undefined) return this.reject(ws, "runtime_offline")
    await this.openChannel(ws, attachment, this.runtimeSocket(device.placementId), { type: "open", channelId: "", ticket: "", kind: "device", deviceId: device.deviceId }, device)
  }

  /** The device socket waiting on `channelId`, while it is still open to join. */
  private waitingDevice(channelId: string): { readonly ws: WebSocket; readonly attachment: WaitingDevice } | undefined {
    for (const ws of this.ctx.getWebSockets("device")) {
      const attachment = attachmentOf(ws)
      if (ws.readyState === WebSocket.OPEN && attachment?.role === "device" && attachment.state === "waiting" && attachment.open.channelId === channelId) return { ws, attachment }
    }
    return undefined
  }

  /** The pairing window `windowId` and the live control socket that
   *  announced it. A window on a socket gone silent is closed: the `open` it
   *  would carry reaches no machine. */
  private pairingWindow(windowId: string): (PairingWindowRecord & { readonly ws: WebSocket }) | undefined {
    const now = Date.now()
    for (const ws of this.ctx.getWebSockets("runtime")) {
      const attachment = attachmentOf(ws)
      if (ws.readyState !== WebSocket.OPEN || attachment?.role !== "runtime" || attachment.placement === undefined || !this.isLive(ws, attachment, now)) continue
      const window = attachment.windows?.find((candidate) => candidate.windowId === windowId)
      if (window) return { ws, placementId: attachment.placement.id, socketId: attachment.socketId, expiresAt: window.expiresAt }
    }
    return undefined
  }

  /** Takes the pairing window `windowId` off every open control socket but
   *  the one `keeperSocketId` names, so at most one socket holds a window. */
  private withdrawWindow(windowId: string, keeperSocketId?: string): void {
    for (const ws of this.ctx.getWebSockets("runtime")) {
      const attachment = attachmentOf(ws)
      if (ws.readyState !== WebSocket.OPEN || attachment?.role !== "runtime" || attachment.socketId === keeperSocketId) continue
      if (!attachment.windows?.some((window) => window.windowId === windowId)) continue
      attachment.windows = attachment.windows.filter((window) => window.windowId !== windowId)
      ws.serializeAttachment(attachment)
    }
  }

  // ---- runtime data channel -----------------------------------------------------

  private async onChannelFrame(ws: WebSocket, attachment: Extract<Attachment, { role: "channel" }>, message: string): Promise<void> {
    if (attachment.channelId !== undefined) return ws.close(1002, "text after accept")
    const frame = decodeJsonFrame(decodeChannelAcceptFrame, message)
    // A device that left took its ticket with it, so its channel is as
    // unknown as one never opened.
    const waiting = this.waitingDevice(frame.channelId)
    if (!waiting || waiting.attachment.open.ticket !== frame.ticket || frame.runtimeId !== (this.ctx.id.name ?? "")) return ws.close(1008, "unknown channel")
    attachment.channelId = frame.channelId
    attachment.deviceSocketId = waiting.attachment.socketId
    ws.serializeAttachment(attachment)
    moveDevice(waiting.ws, waiting.attachment, { state: "attached", channelId: frame.channelId })
    this.send(waiting.ws, { type: "attached" })
  }

  // ---- the pump -----------------------------------------------------------------

  private async pump(ws: WebSocket, attachment: Attachment, frame: ArrayBuffer): Promise<void> {
    // The one binary frame a control channel carries is a client asset chunk.
    if (attachment.role === "runtime") return this.clientAssets.chunk(ws, attachment.socketId, frame)
    if (attachment.role === "device" && attachment.state !== "attached") return ws.close(1002, "binary before attach")
    const channel = attachment.role === "channel" ? { ws, attachment } : this.channelSocket(attachment.channelId)
    const peer = attachment.role === "channel" ? this.peerOf(attachment) : channel?.ws
    if (!peer || !channel) return ws.close(1011, "channel peer missing")
    try {
      peer.send(frame)
    } catch {
      // A peer that refuses a frame is gone; the sender learns it now rather
      // than on the next sweep.
      closeQuietly(peer, 1011, "peer unreachable")
      ws.close(1011, "channel peer missing")
      return
    }
    await this.charge(channel.ws, channel.attachment, frame.byteLength)
  }

  /** Counts a frame the channel carried, either way, against the runtime's
   *  daily budget. A channel that takes the runtime past it ends, and the
   *  device that dials again hears `daily_budget`. */
  private async charge(ws: WebSocket, attachment: ChannelAttachment, bytes: number): Promise<void> {
    const today = await this.pumpedToday()
    today.total += bytes
    attachment.pumped = { day: today.day, bytes: bytesOn(attachment.pumped, today.day) + bytes }
    ws.serializeAttachment(attachment)
    if (attachment.pumped.bytes >= FOLD_BYTES) await this.foldChannel(ws, attachment)
    if (today.total < dailyBudgetBytes(this.env.RELAY_DAILY_GIB)) return
    await this.foldChannel(ws, attachment)
    const peer = this.peerOf(attachment)
    closeQuietly(ws, 1008, "daily_budget")
    if (peer) closeQuietly(peer, 1008, "daily_budget")
  }

  /** Adds what a channel carried today to the stored count. A write the
   *  storage refuses leaves the bytes in the attachment for the next try. */
  private async foldChannel(ws: WebSocket, attachment: ChannelAttachment): Promise<void> {
    if (!attachment.pumped?.bytes) return
    const today = await this.pumpedToday()
    const carried = bytesOn(attachment.pumped, today.day)
    try {
      if (carried > 0) await this.ctx.storage.put(PUMPED_KEY, { day: today.day, bytes: today.stored + carried } satisfies DayBytes)
    } catch {
      return
    }
    today.stored += carried
    attachment.pumped = undefined
    try {
      ws.serializeAttachment(attachment)
    } catch {
      // The socket is gone, and its attachment with it.
    }
  }

  /** Today's pumped bytes, read from storage and every open channel's
   *  attachment once per instance and per UTC day, then advanced in memory. */
  private async pumpedToday(): Promise<{ readonly day: string; stored: number; total: number }> {
    const day = utcDay(Date.now())
    if (this.pumped?.day === day) return this.pumped
    const stored = bytesOn(await this.ctx.storage.get(PUMPED_KEY), day)
    let total = stored
    for (const ws of this.ctx.getWebSockets("channel")) {
      const attachment = attachmentOf(ws)
      if (attachment?.role === "channel") total += bytesOn(attachment.pumped, day)
    }
    this.pumped = { day, stored, total }
    return this.pumped
  }

  /** Whether the operator's `RELAY_ADMISSION` lets this runtime id attach.
   *  A runtime id that attached before has an allowlist row. */
  private async admitsRuntimes(): Promise<boolean> {
    switch (relayAdmission(this.env.RELAY_ADMISSION)) {
      case "open":
        return true
      case "closed":
        return false
      case "existing":
        return (await this.ctx.storage.get("devices")) !== undefined
    }
  }

  /** The machine's side of an accepted data channel. */
  private channelSocket(channelId: string): { readonly ws: WebSocket; readonly attachment: Extract<Attachment, { role: "channel" }> } | undefined {
    for (const ws of this.ctx.getWebSockets("channel")) {
      const attachment = attachmentOf(ws)
      if (attachment?.role === "channel" && attachment.channelId === channelId) return { ws, attachment }
    }
    return undefined
  }

  private peerOf(attachment: Attachment): WebSocket | undefined {
    if (attachment.role === "device" && attachment.state === "attached") return this.channelSocket(attachment.channelId)?.ws
    if (attachment.role === "channel" && attachment.deviceSocketId !== undefined) return this.ctx.getWebSockets(`dev:${attachment.deviceSocketId}`)[0]
    return undefined
  }

  // ---- presence and housekeeping ----------------------------------------------

  /** Whether a runtime or device socket has been heard within its deadline. */
  private isLive(ws: WebSocket, attachment: Extract<Attachment, { role: "runtime" | "device" }>, now: number): boolean {
    return now < silentAt({ lastHeartbeatAt: this.lastHeardAt(ws), acceptedAt: attachment.acceptedAt, deadlineMs: silenceDeadlineMs(attachment) ?? RELAY_SILENCE_DEADLINE_MS })
  }

  /** When this socket last proved its link works: the later of the last ping
   *  the platform answered for this object and the last frame it delivered. */
  private lastHeardAt(ws: WebSocket): number | undefined {
    const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime()
    const framed = this.heardAt.get(ws)
    if (pinged === undefined) return framed
    return framed === undefined ? pinged : Math.max(pinged, framed)
  }

  /** The live control sockets, each with its attachment. */
  private liveRuntimeSockets(now: number): Array<{ ws: WebSocket; attachment: Extract<Attachment, { role: "runtime" }> }> {
    const live: Array<{ ws: WebSocket; attachment: Extract<Attachment, { role: "runtime" }> }> = []
    for (const ws of this.ctx.getWebSockets("runtime")) {
      const attachment = attachmentOf(ws)
      if (ws.readyState === WebSocket.OPEN && attachment?.role === "runtime" && this.isLive(ws, attachment, now)) live.push({ ws, attachment })
    }
    return live
  }

  /** What every live control socket says it serves, oldest socket first. A
   *  placement exists only while a live socket announces it, so a socket that
   *  died without a close event takes its placement with it. */
  private liveAnnouncements(): Array<PlacementAnnouncement & { readonly ws: WebSocket }> {
    return this.liveRuntimeSockets(Date.now()).flatMap(({ ws, attachment }) => attachment.placement === undefined ? [] : [{ ws, socketId: attachment.socketId, placement: attachment.placement }])
  }

  /** The control socket a device's `open` goes to: the runtime serving the
   *  placement, or the remote host that can start one. */
  private runtimeSocket(placementId: string): { readonly ws: WebSocket; readonly socketId: string } | undefined {
    const serving = servingAnnouncement(this.liveAnnouncements(), placementId)
    return serving === undefined ? undefined : { ws: serving.ws, socketId: serving.socketId }
  }

  /** The placements presence reports, in the shape devices decode. */
  private async placements(): Promise<PresencePlacement[]> {
    return servedPlacements(this.liveAnnouncements()).map(presencePlacement)
  }

  private async channelCount(): Promise<number> {
    return this.ctx.getWebSockets("channel").length
  }

  private async broadcastPresence(): Promise<void> {
    const placements = await this.placements()
    for (const socket of this.ctx.getWebSockets("device")) {
      const attachment = attachmentOf(socket)
      if (attachment?.role === "device" && attachment.state === "presence") this.send(socket, { type: "presence", placements })
    }
  }

  /** Stores the allowlist the machine sent, when it differs from the one
   *  stored. A control socket sends it on every attach, and a write that
   *  changes nothing is only a chance for a storage fault to reset the
   *  object. */
  private async storeAllowlist(devices: readonly string[]): Promise<void> {
    const stored = await this.ctx.storage.get<readonly string[]>("devices")
    if (stored?.length === devices.length && stored.every((deviceId, index) => deviceId === devices[index])) return
    await this.ctx.storage.put("devices", devices)
  }

  /** Deletes the rows relays deployed before 2026-10-22 kept for waiting
   *  opens and pairing windows, once per instance, on a machine's attach and never in
   *  the sweep. Each row named a socket that the deploy which moved this
   *  state into attachments already ended, so none of them can still be
   *  used, and nothing reads them. The cleanup is optional, so a storage
   *  error it meets is contained: it must never reach the attach handler,
   *  whose catch-all would refuse the machine as malformed and park its
   *  remote link. The next attach tries again. Remove after 2027-01-22. */
  private async dropLegacyRows(): Promise<void> {
    if (this.legacyRowsDropped) return
    this.legacyRowsDropped = true
    try {
      const keys: string[] = []
      for (const prefix of LEGACY_PREFIXES) keys.push(...(await this.ctx.storage.list({ prefix })).keys())
      if (keys.length > 0) await this.ctx.storage.delete(keys)
    } catch {
      this.legacyRowsDropped = false
    }
  }

  /** When the sweep must next look at a socket: when it falls silent past
   *  its deadline, or when the `open` a device waits on expires, whichever
   *  is first. Undefined for a socket the sweep has no reason to visit. */
  private sweepDueAt(ws: WebSocket, attachment: Attachment): number | undefined {
    const deadlineMs = silenceDeadlineMs(attachment)
    const silent = deadlineMs === undefined ? undefined : silentAt({ lastHeartbeatAt: this.lastHeardAt(ws), acceptedAt: attachment.acceptedAt, deadlineMs })
    return earliest(silent, attachment.role === "device" && attachment.state === "waiting" ? expiresAt(attachment.open) : undefined)
  }

  /** Arms the sweep for a socket that just arrived. The sweep watches only
   *  while a device is connected: a dead socket keeps a person waiting only
   *  when a device is there to wait, presence judges every control socket's
   *  liveness when a device asks, and a machine notices its own dead link
   *  and dials again. So the first device to arrive arms the sweep at the
   *  earliest moment any socket is due, which closes a control socket that
   *  went silent while nobody watched at once. */
  private async armSweep(): Promise<void> {
    if (!this.ctx.getWebSockets("device").some((ws) => ws.readyState === WebSocket.OPEN)) return
    let dueAt: number | undefined
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = attachmentOf(ws)
      if (attachment && ws.readyState === WebSocket.OPEN) dueAt = earliest(dueAt, this.sweepDueAt(ws, attachment))
    }
    if (dueAt !== undefined) await this.scheduleAlarm(dueAt)
  }

  /** Keeps the earlier of the pending alarm and `at`, so a sweep due soon is
   *  never pushed out by a later request. */
  private async scheduleAlarm(at: number): Promise<void> {
    const pending = await this.ctx.storage.getAlarm()
    if (pending === null || at < pending) await this.ctx.storage.setAlarm(at)
  }

  /** Housekeeping on a timer, in one pass over the sockets and with no
   *  storage call but the next alarm: expires `open` tickets the runtime never
   *  claimed, so the device parked on them learns the runtime is not coming;
   *  closes every socket that sent neither a ping nor a frame within its
   *  deadline, so a machine whose network vanished leaves presence within one
   *  deadline and a device behind a machine's silent data channel hears it within that
   *  channel's; and closes a channel whose device socket is gone, because a
   *  channel with no device behind it holds the runtime's side open as a
   *  client that is not there. A socket closed for silence is released as
   *  closed, which closes its channel peer with the reason. Closing a
   *  half-open socket never reports back, so the sweep releases it itself,
   *  skips it from then on, and no single socket's refusal may end the sweep
   *  for the rest. The sweep runs again when the next socket it watches is
   *  due, which is the latest moment that still closes a silent socket on
   *  its deadline, and only while a device is still connected (`armSweep`).
   *  The platform deletes an alarm as it fires, so a sweep that sets none
   *  leaves the object free to hibernate with nothing scheduled. */
  override async alarm(): Promise<void> {
    const now = Date.now()
    let nextAt: number | undefined
    let watching = false
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = attachmentOf(ws)
      if (!attachment || ws.readyState !== WebSocket.OPEN) continue
      if (attachment.role === "channel" && attachment.deviceSocketId !== undefined && this.peerOf(attachment) === undefined) {
        closeQuietly(ws, 1000, "peer closed: device left")
        continue
      }
      if (attachment.role === "device" && attachment.state === "waiting" && now >= expiresAt(attachment.open)) {
        this.reject(ws, "runtime_offline")
        continue
      }
      const dueAt = this.sweepDueAt(ws, attachment)
      if (dueAt === undefined || now < dueAt) {
        nextAt = earliest(nextAt, dueAt)
        watching ||= attachment.role === "device"
        continue
      }
      closeQuietly(ws, 1001, "heartbeat timeout")
      await this.release(ws, attachment, 1001, "heartbeat timeout")
    }
    // Not `scheduleAlarm`: inside this handler the fired alarm reads as none.
    if (watching && nextAt !== undefined) await this.ctx.storage.setAlarm(nextAt)
  }

  /** A frame to a socket that is already gone is lost, and that is the whole
   *  of it: the socket's close is what the sender acts on, never the send. */
  private send(ws: WebSocket, frame: RelayControlFrame | RelayDeviceFrame): void {
    try {
      ws.send(JSON.stringify(frame))
    } catch {
      // Already closed.
    }
  }

  private reject(ws: WebSocket, reason: RelayRejectReason): void {
    this.send(ws, { type: "rejected", reason })
    closeQuietly(ws, 1008, reason)
  }
}
