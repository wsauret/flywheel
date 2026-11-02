import { CLIENT_IDENTITY_PATTERN } from "../../../src/protocol/client-identity.js"
import { decodeAssetChunk, newAssetRequestId, type RelayControlFrame } from "../../../src/protocol/modules/remote/relay-protocol.js"
import type { PlacementAnnouncement } from "./admission.js"
import { CLIENT_FILE_MAX_BYTES, clientFileType, newestClientIdentity, readClientAsset, storeClientAsset, type ClientCacheStorage } from "./client-cache.js"

/** The web client a runtime's machines serve, by identity, to phones on any
 *  origin (`GET /client/<runtimeId>/<identity>/phone/<file>`), and which
 *  identity that is (`GET /client/<runtimeId>/current`), because presence
 *  never carries it: presence keeps the shape phones already decode. A file
 *  is served from the runtime object's cache when that identity was streamed
 *  before, otherwise from a machine that announces it, asked over that
 *  machine's control channel and kept once the whole file has arrived. A
 *  transfer lives in memory, and the phone's open request keeps the object
 *  from being evicted until it ends. */

/** How long a machine may take to answer an asset request, and to send the
 *  next chunk once it has started. */
const ASSET_SILENCE_MS = 15_000

/** What a phone may cache and read across origins. The client is public,
 *  immutable, and keyed by a public runtime id and a content hash; the hosted
 *  page loads it as a module script from another origin, which is a CORS
 *  fetch that fails without the allow header.
 *
 *  The rest keeps a runtime's bytes inert on this domain. `nosniff` holds the
 *  browser to the type the relay names, so a file is never run or shown as
 *  something else. The policy applies only where a response becomes a
 *  document or a worker, as when a person opens a file's address: there it
 *  runs no script, loads nothing, and has an opaque origin. A browser applies
 *  no response policy to a script or a style sheet that a page loads, so the
 *  hosted page loads the shell as before. */
const ASSET_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Timing-Allow-Origin": "*",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'",
} as const
const IMMUTABLE = "public, max-age=31536000, immutable"

type AssetHead = { readonly kind: "found" } | { readonly kind: "missing" } | { readonly kind: "failed" }

/** One client file on its way from a machine to a phone. */
interface AssetTransfer {
  readonly identity: string
  readonly file: string
  readonly socketId: string
  readonly head: PromiseWithResolvers<AssetHead>
  readonly frames: Uint8Array[]
  readonly body: ReadableStream<Uint8Array>
  readonly controller: ReadableStreamDefaultController<Uint8Array>
  /** Whether the machine has answered with `asset.head`. */
  started: boolean
  bytes: number
  silence?: ReturnType<typeof setTimeout>
}

/** A live control socket and the placement it announces. */
type ServingMachine = PlacementAnnouncement & { readonly ws: WebSocket }

/** Which client a runtime serves: the identity a live placement announces,
 *  or while none does, the one the relay stored most recently. Never cached,
 *  because it changes with every build the machine runs. */
function currentClientResponse(identity: string | undefined): Response {
  if (identity === undefined) return assetRefusal(503)
  return Response.json({ identity }, { headers: { ...ASSET_HEADERS, "Cache-Control": "no-store" } })
}

function assetRefusal(status: 404 | 503): Response {
  return new Response(status === 404 ? "no such client file" : "no machine serves this client right now", {
    status,
    headers: { ...ASSET_HEADERS, "Cache-Control": "no-store", ...(status === 503 ? { "Retry-After": "5" } : {}) },
  })
}

function assetResponse(identity: string, contentType: string, body: ReadableStream<Uint8Array>): Response {
  // No Content-Length: the body streams as the machine sends it, and a
  // length promised before the last chunk is a length the edge may drop.
  return new Response(body, { headers: { ...ASSET_HEADERS, "Content-Type": contentType, "Cache-Control": IMMUTABLE, ETag: `"${identity}"` } })
}

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index]
      index += 1
      if (chunk === undefined) controller.close()
      else controller.enqueue(chunk)
    },
  })
}

/** One runtime object's client route. `machines` are the live control
 *  sockets that announce a placement, oldest first; `send` writes a frame to
 *  one of them. Each answer from a machine names the control socket it came
 *  on, and a transfer answers only to the socket it was asked on. */
export class ClientAssetServer {
  private readonly transfers = new Map<string, AssetTransfer>()

  constructor(
    private readonly storage: ClientCacheStorage,
    private readonly machines: () => readonly ServingMachine[],
    private readonly send: (ws: WebSocket, frame: RelayControlFrame) => void,
  ) {}

  /** Answers `GET /client/<runtimeId>/<path>`. */
  async serve(request: Request, path: readonly string[]): Promise<Response> {
    if (request.method !== "GET") return new Response("GET only", { status: 405, headers: ASSET_HEADERS })
    if (path.length === 1 && path[0] === "current") return currentClientResponse(this.announcedClient() ?? await newestClientIdentity(this.storage))
    const [identity, host, file, ...extra] = path
    const contentType = file === undefined ? undefined : clientFileType(file)
    if (identity === undefined || !CLIENT_IDENTITY_PATTERN.test(identity) || host !== "phone" || file === undefined || contentType === undefined || extra.length > 0) return assetRefusal(404)
    const cached = await readClientAsset(this.storage, identity, file)
    if (cached) return assetResponse(identity, contentType, streamOf(cached))
    const machine = this.machines().find((announcement) => announcement.placement.clientIdentity === identity)
    if (!machine) return assetRefusal(503)
    return this.streamFromMachine(machine, identity, file, contentType)
  }

  /** `asset.head`: the machine has the file and its chunks follow. The type
   *  the machine names is not read: the relay types a client file by its
   *  name (`clientFileType`). */
  started(requestId: string, socketId: string): void {
    const transfer = this.transferOn(requestId, socketId)
    if (!transfer || transfer.started) return
    transfer.started = true
    this.touchTransfer(requestId, transfer)
    transfer.head.resolve({ kind: "found" })
  }

  /** `asset.missing`: the machine has no such file. */
  missing(requestId: string, socketId: string): void {
    const transfer = this.transferOn(requestId, socketId)
    if (!transfer) return
    this.transfers.delete(requestId)
    clearTimeout(transfer.silence)
    transfer.head.resolve({ kind: "missing" })
  }

  /** One binary chunk frame on a control socket, the only binary frame a
   *  control socket carries. A frame that answers no started transfer closes
   *  the socket. */
  chunk(ws: WebSocket, socketId: string, frame: ArrayBuffer): void {
    let chunk: ReturnType<typeof decodeAssetChunk>
    try {
      chunk = decodeAssetChunk(frame)
    } catch {
      return ws.close(1003, "binary on control channel")
    }
    const transfer = this.transferOn(chunk.requestId, socketId)
    if (!transfer?.started) return ws.close(1003, "binary on control channel")
    transfer.bytes += chunk.bytes.byteLength
    if (transfer.bytes > CLIENT_FILE_MAX_BYTES) return this.failTransfer(chunk.requestId, "the client file is larger than the relay keeps")
    // The frame's buffer is this message's; the stored row must own its bytes.
    const bytes = chunk.bytes.slice()
    transfer.frames.push(bytes)
    this.touchTransfer(chunk.requestId, transfer)
    try {
      transfer.controller.enqueue(bytes)
    } catch {
      // The phone went away; the transfer continues so the cache fills.
    }
  }

  /** `asset.end`: the phone's response ends, and the whole file is kept. */
  async ended(requestId: string, socketId: string): Promise<void> {
    const transfer = this.transferOn(requestId, socketId)
    if (!transfer) return
    this.transfers.delete(requestId)
    clearTimeout(transfer.silence)
    try {
      transfer.controller.close()
    } catch {
      // The phone went away.
    }
    if (!transfer.started) return
    try {
      // A newly kept identity replaces every identity no live placement still
      // announces; two announced at once (an installed and a development lane)
      // both stay. A file past the cache's limits is not kept, which costs
      // the next phone one more transfer from the machine.
      const announced = this.machines().flatMap((announcement) => announcement.placement.clientIdentity === undefined ? [] : [announcement.placement.clientIdentity])
      await storeClientAsset(this.storage, transfer.identity, transfer.file, transfer.frames, new Set(announced))
    } catch {
      // The phone has its file. Storage refusing it costs the next phone one
      // more transfer from the machine, and must not close the machine's
      // control channel, which the caller would do for an error it sees.
    }
  }

  /** Ends every transfer the control socket `socketId` was asked for. */
  machineLeft(socketId: string): void {
    for (const [requestId, transfer] of this.transfers) {
      if (transfer.socketId === socketId) this.failTransfer(requestId, "the machine left")
    }
  }

  /** The identity the newest live placement announces, a running runtime's
   *  before the account service's word for an asleep one. */
  private announcedClient(): string | undefined {
    const announcing = this.machines().filter((announcement) => announcement.placement.clientIdentity !== undefined)
    return (announcing.findLast((announcement) => announcement.placement.state === "live") ?? announcing.at(-1))?.placement.clientIdentity
  }

  /** Asks the machine for the file and streams it to the phone as it
   *  arrives; the whole file is kept once the machine says it has ended. */
  private async streamFromMachine(machine: ServingMachine, identity: string, file: string, contentType: string): Promise<Response> {
    const requestId = newAssetRequestId()
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    // A phone that stops reading does not stop the transfer: the file is
    // still worth keeping for the next phone.
    const body = new ReadableStream<Uint8Array>({ start(started) { controller = started } })
    if (!controller) throw new Error("the stream did not start")
    const transfer: AssetTransfer = { identity, file, socketId: machine.socketId, head: Promise.withResolvers<AssetHead>(), frames: [], body, controller, started: false, bytes: 0 }
    this.transfers.set(requestId, transfer)
    this.touchTransfer(requestId, transfer)
    this.send(machine.ws, { type: "asset.request", requestId, identity, file })
    const head = await transfer.head.promise
    if (head.kind === "found") return assetResponse(identity, contentType, transfer.body)
    return assetRefusal(head.kind === "missing" ? 404 : 503)
  }

  /** Restarts the silence timer: a machine that stops answering ends the
   *  transfer rather than leaving a phone waiting on a request forever. */
  private touchTransfer(requestId: string, transfer: AssetTransfer): void {
    clearTimeout(transfer.silence)
    transfer.silence = setTimeout(() => this.failTransfer(requestId, "the machine stopped sending the file"), ASSET_SILENCE_MS)
  }

  private failTransfer(requestId: string, reason: string): void {
    const transfer = this.transfers.get(requestId)
    if (!transfer) return
    this.transfers.delete(requestId)
    clearTimeout(transfer.silence)
    transfer.head.resolve({ kind: "failed" })
    try {
      transfer.controller.error(new Error(reason))
    } catch {
      // The phone already went away.
    }
  }

  private transferOn(requestId: string, socketId: string): AssetTransfer | undefined {
    const transfer = this.transfers.get(requestId)
    return transfer?.socketId === socketId ? transfer : undefined
  }
}
