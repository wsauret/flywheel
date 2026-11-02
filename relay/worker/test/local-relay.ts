import { join } from "node:path"
import { convertV4MiniflareOptions, Miniflare } from "miniflare"

/** The relay Worker run on this machine: the Worker source bundled the way
 *  wrangler bundles it, served by workerd through Miniflare with its
 *  `RelayRuntime` Durable Object on SQLite storage, as `wrangler dev` serves
 *  it. It listens on an ephemeral loopback port and needs no network and no
 *  Cloudflare account, so the relay's own tests and the release performance
 *  gate reach the real relay hermetically. The relay's state lives in memory
 *  and ends with `dispose`. */

const WORKER_ENTRY = join(import.meta.dir, "..", "src", "index.ts")

export interface LocalRelay {
  readonly miniflare: Miniflare
  /** The relay's HTTP origin, such as `http://127.0.0.1:53123`. */
  readonly origin: string
  /** The relay URL a runtime pairs against, as `flywheel remote pair --relay` takes it. */
  readonly url: string
}

/** What a test may set beyond the relay's code: the operator's Worker
 *  variables, and the sockets one client IP may open a minute, which is far
 *  above production's here because every test socket comes from loopback. */
export interface LocalRelayOptions {
  readonly vars?: { readonly RELAY_DAILY_GIB?: string; readonly RELAY_ADMISSION?: string }
  readonly socketsPerMinute?: number
}

/** `entry` is the Worker module to serve, the relay's own unless a test
 *  serves a wrapper around it. */
export async function startLocalRelay(entry = WORKER_ENTRY, options: LocalRelayOptions = {}): Promise<LocalRelay> {
  const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm", external: ["cloudflare:workers"] })
  if (!built.success) throw new AggregateError(built.logs, "the relay Worker did not build")
  const miniflare = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: await built.outputs[0]!.text(),
    compatibilityDate: "2026-08-27",
    durableObjects: { RELAY_RUNTIME: { className: "RelayRuntime", useSQLite: true } },
    ratelimits: { RELAY_SOCKET_RATE_LIMITER: { namespace_id: "1003", simple: { limit: options.socketsPerMinute ?? 100_000, period: 60 } } },
    bindings: { ...options.vars },
  }))
  try {
    const origin = (await miniflare.ready).origin
    return { miniflare, origin, url: origin.replace(/^http/, "ws") }
  } catch (error) {
    await miniflare.dispose()
    throw error
  }
}

/** The local relay in a process of its own, for a caller whose crash must not
 *  leave workerd running. workerd does not exit when the process that started
 *  it dies, so the host reads its stdin and disposes the relay when the
 *  caller closes the pipe or dies. `tag` goes on the host's command line, so a
 *  sweep that matches processes by command line, as the performance gate does
 *  on Windows, finds the host and ends its process tree with it. */
export interface LocalRelayProcess {
  /** The relay URL a runtime pairs against. */
  readonly url: string
  /** Disposes the relay and waits for the host to exit. */
  readonly close: () => Promise<void>
}

const HOST_EXIT_TIMEOUT_MS = 10_000

export async function spawnLocalRelay(tag: string): Promise<LocalRelayProcess> {
  const host = Bun.spawn([process.execPath, import.meta.path, tag], { stdin: "pipe", stdout: "pipe", stderr: "inherit", windowsHide: true })
  const close = async (): Promise<void> => {
    void host.stdin.end()
    const exited = await Promise.race([host.exited.then(() => true), Bun.sleep(HOST_EXIT_TIMEOUT_MS).then(() => false)])
    if (!exited) host.kill()
  }
  try {
    return { url: await firstLine(host.stdout), close }
  } catch (error) {
    await close()
    throw error
  }
}

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let buffered = ""
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true })
    const end = buffered.indexOf("\n")
    if (end >= 0) return buffered.slice(0, end).trim()
  }
  throw new Error("the local relay host exited before it printed its URL")
}

if (import.meta.main) {
  const relay = await startLocalRelay()
  process.stdout.write(`${relay.url}\n`)
  for await (const _chunk of Bun.stdin.stream()) {
    // The caller writes nothing; the stream ends when it closes the pipe or dies.
  }
  await relay.miniflare.dispose()
}
