import type { Server } from "bun"

import { errnoCode } from "../../../infra/error-message.js"
import { Log } from "../../../infra/log.js"
import { projectWebPort } from "../../../infra/paths.js"
import { brandTileSvg } from "../../../protocol/client/brand.js"
import { applyControlUiSecurityHeaders } from "./control-ui-csp.js"
import { isReadHttpMethod, respondPlainText } from "./control-ui-http-utils.js"
import { escapeHtml, renderFlywheelPage, renderLoadingCard } from "./flywheel-page.js"
import { isServedOrigin } from "./origin-check.js"

const log = Log.create({ service: "project-addresses" })

const HOSTNAME = "127.0.0.1"

/** A known project's state, as its address reads it. A project that holds
 *  its runtime, opening, open, or closing, owns its address or is about to:
 *  this binds a free address only for a project that holds nothing. */
export type ProjectAddressReading =
  | { readonly kind: "asleep" }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "held" }

export interface ProjectAddressOptions {
  /** Every known project, with the name its page shows. */
  readonly listProjects: () => Promise<readonly { readonly projectRoot: string; readonly label: string }[]>
  readonly reading: (projectRoot: string) => ProjectAddressReading
  /** Calls the listener with a project's root each time its reading can have changed. */
  readonly watch: (listener: (projectRoot: string) => void) => () => void
  /** Starts the project. A failure shows in the reading, so this never throws. */
  readonly wake: (projectRoot: string) => void
  /** The project list, which a failed project's page links to for a retry. */
  readonly hubOrigin: string
  /** The port a project's address binds among the known projects: the
   *  project's own unless a test says otherwise. */
  readonly port?: (projectRoot: string, knownProjectRoots: readonly string[]) => number
}

export interface ProjectAddresses {
  /** The origin this answers a project's address at, while it keeps it. */
  readonly origin: (projectRoot: string) => string | undefined
  /** Lets go of one project's address: for the project's own endpoint, which
   *  binds it next, or for a project that left the registry. */
  readonly release: (projectRoot: string) => void
  /** Lets go of every address at once, for a successor to bind. */
  readonly stop: () => void
}

/** Keeps every known project's own address answering while the project is
 *  not open (PI-LOCAL-002). A project's browser endpoint listens only while
 *  the project is open, so without this a bookmark of an asleep project, and
 *  a tab left open across a restart of the account service, would reach
 *  nothing. A page load there, or a client of the page that knocks at the
 *  socket, starts the project. The address keeps answering while the project
 *  opens, and the project's endpoint takes it over when it binds, so the
 *  page's next reload lands on the client at the same address. */
export function keepProjectAddresses(options: ProjectAddressOptions): ProjectAddresses {
  const servers = new Map<string, Server<undefined>>()
  const refused = new Set<string>()
  const portOf = options.port ?? projectWebPort
  let stopped = false
  const icon = brandTileSvg(512, { corners: "rounded" })

  const release = (projectRoot: string): void => {
    const server = servers.get(projectRoot)
    if (server === undefined) return
    servers.delete(projectRoot)
    server.stop(true)
  }
  const hold = (projectRoot: string, label: string, port: number): void => {
    if (stopped || servers.has(projectRoot) || options.reading(projectRoot).kind === "held") return
    let server: Server<undefined>
    try {
      server = Bun.serve({ hostname: HOSTNAME, port, fetch: (request) => answer(request, projectRoot, label, `http://${HOSTNAME}:${server.port}`) })
    } catch (error) {
      // Another program, or another lane's service, holds the port. The
      // project still binds an address of its own when it opens.
      if (!refused.has(projectRoot)) log.info("a project's address is held by another program", { projectRoot, port, code: errnoCode(error) })
      refused.add(projectRoot)
      return
    }
    refused.delete(projectRoot)
    servers.set(projectRoot, server)
  }
  const reconcile = async (only?: string): Promise<void> => {
    let projects: Awaited<ReturnType<ProjectAddressOptions["listProjects"]>>
    try {
      projects = await options.listProjects()
    } catch (error) {
      log.warn("the known projects could not be read, so their addresses wait for the next change", { error: errnoCode(error) ?? (error instanceof Error ? error.name : typeof error) })
      return
    }
    const known = projects.map((project) => project.projectRoot)
    for (const project of projects) {
      if (only === undefined || project.projectRoot === only) hold(project.projectRoot, project.label, portOf(project.projectRoot, known))
    }
  }
  const answer = (request: Request, projectRoot: string, label: string, origin: string): Response => {
    const headers = applyControlUiSecurityHeaders(new Headers())
    headers.set("Cache-Control", "no-store")
    // Another site may not start a project by pointing at its address.
    if (request.headers.get("Sec-Fetch-Site") === "cross-site") return respondPlainText(403, "Forbidden", headers)
    const url = new URL(request.url)
    if (url.pathname === "/icon.svg" && isReadHttpMethod(request.method)) {
      headers.set("Content-Type", "image/svg+xml")
      return new Response(icon, { headers })
    }
    const reading = options.reading(projectRoot)
    // A browser loads a page asking for HTML by name; a script or an image
    // asks for anything, and starts nothing.
    const page = isReadHttpMethod(request.method) && url.pathname !== "/socket" && /\btext\/html\b/.test(request.headers.get("Accept") ?? "")
    const name = escapeHtml(label)
    if (reading.kind === "failed") {
      if (!page) return respondPlainText(503, `The project did not open: ${reading.error}`, headers)
      headers.set("Content-Type", "text/html; charset=utf-8")
      return new Response(renderFlywheelPage({
        title: `${name} | Flywheel`,
        style: "main{max-width:42ch}h1{font-size:15px}",
        body: `<h1>${name}</h1><p role="alert">${escapeHtml(reading.error)}</p><p><a href="${escapeHtml(options.hubOrigin)}/">Open the project list to retry.</a></p>`,
      }), { status: 503, headers })
    }
    // The page's own client knocks at the socket when it reattaches, and the
    // browser names the page's origin there, so that knock is the client
    // asking for its project.
    if (page || (url.pathname === "/socket" && isServedOrigin(request.headers.get("Origin"), origin))) options.wake(projectRoot)
    headers.set("Retry-After", "1")
    if (!page) return respondPlainText(503, "The project is starting. Try again shortly.", headers)
    headers.set("Content-Type", "text/html; charset=utf-8")
    return new Response(renderFlywheelPage({
      title: `${name} | Flywheel`,
      refreshSeconds: 1,
      body: renderLoadingCard("Starting Flywheel", `Starting ${name}.`),
    }), { status: 503, headers })
  }

  const unwatch = options.watch((projectRoot) => {
    if (options.reading(projectRoot).kind !== "held") void reconcile(projectRoot)
  })
  void reconcile()
  return {
    origin: (projectRoot) => {
      const server = servers.get(projectRoot)
      return server === undefined ? undefined : `http://${HOSTNAME}:${server.port}`
    },
    release,
    stop: () => {
      stopped = true
      unwatch()
      // A Map skips entries deleted while it iterates, so release can delete.
      for (const projectRoot of servers.keys()) release(projectRoot)
    },
  }
}
