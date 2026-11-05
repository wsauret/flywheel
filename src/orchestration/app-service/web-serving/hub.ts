import type { ServeLane } from "../../../infra/cli-subprocess.js"
import { ACCOUNT_HUB_HOSTNAME, accountHubOrigin, accountHubPort } from "../../../infra/paths.js"
import { brandTileSvg } from "../../../protocol/client/brand.js"
import { ServeStartupFailure } from "../../../protocol/serve-handshake.js"
import { applyControlUiSecurityHeaders } from "./control-ui-csp.js"
import { escapeHtml, renderFlywheelPage, renderLoadingCard } from "./flywheel-page.js"
import { authorizeHubMutation } from "./origin-check.js"

const HUB_COOKIE = "flywheel_hub"

export interface Hub {
  /** The origin the hub answers at, which every link to it names. */
  readonly origin: string
  /** Whether this runtime currently serves the hub. */
  readonly held: () => boolean
  readonly stop: () => void
}

type AccountHubProjectState = "asleep" | "starting" | "closing" | "open" | "failed" | "unavailable"

export interface AccountHubProject {
  readonly id: string
  readonly label: string
  readonly projectRoot: string
  readonly state: AccountHubProjectState
  readonly link?: string
  readonly error?: string
}

export interface AccountHubOptions {
  /** The lane whose fixed port and origin this hub serves. */
  readonly lane: ServeLane
  readonly listProjects: () => Promise<readonly AccountHubProject[]>
  readonly openProject: (id: string) => Promise<string>
  /** Forgets one registered project so no surface offers it again until it is opened here. */
  readonly forgetProject: (id: string) => Promise<void>
  readonly credential: string
}

/** Starts the account-owned wake surface on its lane's fixed loopback
 *  address. When another program holds that port, it throws the failure
 *  that `hubBindFailure` gives. It throws any other bind error unchanged. */
export function startAccountHub(options: AccountHubOptions): Hub {
  const origin = accountHubOrigin(options.lane)
  const handler = createAccountHubHandler(options, origin)
  const port = accountHubPort(options.lane)
  try {
    const server = Bun.serve({ hostname: ACCOUNT_HUB_HOSTNAME, port, fetch: handler })
    return {
      origin,
      held: () => true,
      stop: () => { server.stop(true) },
    }
  } catch (error) {
    throw hubBindFailure(error, port) ?? error
  }
}

/** The start failure for a hub bind error that reports a port another
 *  program holds, or none for any other error. A held port is the host's
 *  state and not this build's failure, so the start names it as its refusal,
 *  with the port, and a client shows the remedy that works. */
export function hubBindFailure(error: unknown, port: number): ServeStartupFailure | undefined {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE"
    ? new ServeStartupFailure(error.message, { kind: "port-in-use", port })
    : undefined
}

function accountHeaders(): Headers {
  const headers = applyControlUiSecurityHeaders(new Headers())
  headers.set("Cache-Control", "no-store")
  return headers
}

function duplicatePath(project: AccountHubProject, projects: readonly AccountHubProject[]): string {
  const peers = projects.filter((candidate) => candidate.label === project.label)
  const segments = project.projectRoot.split(/[\\/]/).filter(Boolean)
  for (let count = 2; count <= segments.length; count += 1) {
    const suffix = segments.slice(-count).join("/")
    if (peers.every((candidate) => candidate.id === project.id || !candidate.projectRoot.replaceAll("\\", "/").endsWith(suffix))) {
      return `${count < segments.length ? "…/" : project.projectRoot.startsWith("/") ? "/" : ""}${suffix}`
    }
  }
  return project.projectRoot
}

/** What the list says after a mutation that it refused or completed. A page
 *  with a notice is where a person just acted, so it starts no project by
 *  itself. */
const NOTICES = {
  stale: "The project list was out of date, so nothing changed. Choose the project again.",
  removed: "Removed the project from this list.",
  gone: "That project is no longer on this list. Choose a project again.",
  failed: "The project did not start. Its row says why. Choose Retry after you repair the cause.",
} as const
type HubNotice = keyof typeof NOTICES

function hubNotice(url: URL): HubNotice | undefined {
  const notice = url.searchParams.get("notice")
  return notice !== null && isHubNotice(notice) ? notice : undefined
}

function isHubNotice(value: string): value is HubNotice {
  return Object.hasOwn(NOTICES, value)
}

const LIST_STYLE = `main{width:min(42rem,100%)}h1{font-size:1rem}.notice{margin:0 0 .75rem;color:var(--fw-fg-muted)}ul{list-style:none;margin:0;padding:0;display:grid;gap:.5rem}li{display:grid;grid-template-columns:minmax(0,1fr) auto 5.5rem 5.5rem;align-items:center;gap:.75rem;padding:.75rem;border:1px solid var(--fw-hairline);border-radius:.5rem;background:var(--fw-raised)}.identity{min-width:0;display:grid}.path,.state,.empty{color:var(--fw-fg-muted)}.path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.action,button{display:inline-block;width:100%;padding:.45rem .75rem;border:1px solid var(--fw-hairline);border-radius:.35rem;background:var(--fw-secondary);color:inherit;font:inherit;text-align:center;text-decoration:none;cursor:pointer}.action:hover,button:enabled:hover{background:var(--fw-secondary-hover)}button:disabled{opacity:.6;cursor:default}.remove button{border-color:transparent;background:transparent;color:var(--fw-fg-muted)}.remove button:hover{background:transparent;color:var(--fw-error)}@media(max-width:30rem){li{grid-template-columns:minmax(0,1fr) 5.5rem 5.5rem}.state{grid-row:2;grid-column:1}.action,.open{grid-row:1/span 2;grid-column:2}.remove{grid-row:1/span 2;grid-column:3}.path{white-space:normal;overflow-wrap:anywhere}}`

function renderAccountPage(projects: readonly AccountHubProject[], notice: HubNotice | undefined): string {
  const duplicateLabels = new Set(projects.filter((project, index) =>
    projects.findIndex((candidate) => candidate.label === project.label) !== index).map((project) => project.label))
  const rows = projects.map((project) => {
    const duplicate = duplicateLabels.has(project.label)
    const detail = duplicate
      ? `<span class="path" title="${escapeHtml(project.projectRoot)}">${escapeHtml(duplicatePath(project, projects))}</span>`
      : ""
    // Each control names its project, with the path that tells two projects
    // of one name apart, so a screen reader never reads two identical rows.
    const name = escapeHtml(duplicate ? `${project.label} (${project.projectRoot})` : project.label)
    const failed = project.state === "failed" || project.state === "unavailable"
    const failure = failed ? `<span role="alert">${escapeHtml(project.error ?? "Project failed to open")}</span>` : ""
    // The state cell is the one state cue. A control that is not available
    // yet keeps its own name and is disabled.
    const disabled = project.state === "starting" || project.state === "closing" ? " disabled aria-disabled=\"true\"" : ""
    const verb = failed ? "Retry" : "Open"
    const action = project.state === "open" && project.link
      ? `<a class="action" href="${escapeHtml(project.link)}" aria-label="Open ${name}">Open</a>`
      : `<form class="open" method="post" action="/projects/${encodeURIComponent(project.id)}/open"><button type="submit" aria-label="${verb} ${name}"${disabled}>${verb}</button></form>`
    // Only a project no surface is using leaves the list from here; an open
    // or starting one is somebody's, and closing it is not this page's call.
    // A row without Remove keeps the cell, so every Open sits in one column.
    const remove = removable(project)
      ? `<form class="remove" method="post" action="/projects/${encodeURIComponent(project.id)}/forget"><button type="submit" aria-label="Remove ${name} from this list">Remove</button></form>`
      : `<span class="remove"></span>`
    return `<li><div class="identity"><strong>${escapeHtml(project.label)}</strong>${detail}${failure}</div><span class="state">${escapeHtml(project.state)}</span>${action}${remove}</li>`
  }).join("")
  const lead = notice === undefined ? "" : `<p class="notice" role="status">${NOTICES[notice]}</p>`
  const body = projects.length === 0
    ? `<p class="empty">No project is registered. Open Flywheel in a project's terminal to add it.</p>`
    : `<ul>${rows}</ul>`
  return renderFlywheelPage({
    title: "Flywheel",
    body: `<h1>Flywheel projects</h1>${lead}${body}`,
    style: LIST_STYLE,
    ...projects.some((project) => project.state === "starting" || project.state === "closing") ? { refreshSeconds: 1 } : {},
    // PI-LOCAL-005, PI-LOCAL-007: the address starts the one known project when it sleeps,
    // and retries it once when it failed to start. A retry that fails again
    // returns with the failed notice, which starts nothing.
    ...notice === undefined && projects.length === 1 && (projects[0]?.state === "asleep" || projects[0]?.state === "failed") ? { script: "/hub.js" } : {},
  })
}

function removable(project: AccountHubProject): boolean {
  return project.state === "asleep" || project.state === "failed"
}

function renderProjectStatus(project: AccountHubProject): string {
  const label = escapeHtml(project.label)
  const title = `${label} | Flywheel`
  if (project.state === "failed" || project.state === "unavailable") {
    return renderFlywheelPage({
      title,
      style: "main{max-width:42ch}h1{font-size:15px}",
      body: `<h1>${label}</h1><p role="alert">${escapeHtml(project.error ?? "Project failed to open")}</p><p><a href="/?notice=failed">Return to projects.</a></p>`,
    })
  }
  const closing = project.state === "closing"
  return renderFlywheelPage({
    title,
    refreshSeconds: 1,
    body: renderLoadingCard(closing ? "Closing Flywheel" : "Starting Flywheel", `${closing ? "Closing" : "Opening"} ${label}.`),
  })
}

/** Creates the account hub request boundary for the hub served at `origin`.
 * Reads never open projects; the two mutations start or forget one opaque
 * registry id, only from a page of that origin, and always return to a
 * nonmutating route. */
export function createAccountHubHandler(options: AccountHubOptions, origin: string): (request: Request) => Promise<Response> {
  const starts = new Set<string>()
  // The same tile the web client serves as its icon, so a bookmark of the
  // project list carries the drawing the project pages carry.
  const icon = brandTileSvg(512, { corners: "rounded" })
  const projects = async (): Promise<AccountHubProject[]> => (await options.listProjects()).map((project) => {
    if (!starts.has(project.id) || project.state === "open" || project.state === "starting" || project.state === "closing") return project
    return { ...project, state: "starting" }
  })
  const see = (location: string, headers: Headers): Response => {
    headers.set("Location", location)
    return new Response(null, { status: 303, headers })
  }
  // Every read answers with its whole body, HEAD included: the server sends
  // the headers of a HEAD answer alone, with the length its GET body has.
  return async (request) => {
    const url = new URL(request.url)
    const headers = accountHeaders()
    if (url.pathname === "/icon.svg") {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers })
      headers.set("Content-Type", "image/svg+xml")
      return new Response(icon, { headers })
    }
    if (url.pathname === "/hub.js") {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers })
      headers.set("Content-Type", "text/javascript; charset=utf-8")
      return new Response(`document.querySelector("form.open")?.requestSubmit();\n`, { headers })
    }
    const route = /^\/projects\/([^/]+)\/(open|forget|status)$/.exec(url.pathname)
    if (route?.[2] === "open" || route?.[2] === "forget") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers })
      // A post from a page that an older service rendered carries a stale
      // credential. It lands on a fresh list (Post/Redirect/Get), whose GET
      // sets the current credential, so the browser's Reload reads the list
      // again instead of posting the stale form again.
      if (!authorizeHubMutation(request.headers, origin, options.credential)) return see("/?notice=stale", headers)
      if ((await request.text()).length !== 0) return new Response("Request body is not allowed", { status: 400, headers })
      const id = decodeURIComponent(route[1] ?? "")
      const project = (await projects()).find((candidate) => candidate.id === id)
      if (!project) return see("/?notice=gone", headers)
      if (route[2] === "forget") {
        if (!removable(project)) return new Response("Close the project on every surface before removing it", { status: 409, headers })
        await options.forgetProject(id)
        return see("/?notice=removed", headers)
      }
      if (!starts.has(id)) {
        starts.add(id)
        void options.openProject(id).catch(() => {}).finally(() => {
          starts.delete(id)
        })
      }
      return see(`/projects/${encodeURIComponent(id)}/status`, headers)
    }
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers })
    if (route?.[2] === "status") {
      const id = decodeURIComponent(route[1] ?? "")
      const project = (await projects()).find((candidate) => candidate.id === id)
      if (!project) return new Response("Not Found", { status: 404, headers })
      if (project.state === "open" && project.link) {
        headers.set("Location", project.link)
        return new Response(null, { status: 302, headers })
      }
      headers.set("Content-Type", "text/html; charset=utf-8")
      return new Response(renderProjectStatus(project), { headers })
    }
    if (url.pathname !== "/") return new Response("Not Found", { status: 404, headers })
    const listed = await projects()
    const notice = hubNotice(url)
    if (notice === undefined && listed.length === 1 && listed[0]?.state === "open" && listed[0].link) {
      headers.set("Location", listed[0].link)
      return new Response(null, { status: 302, headers })
    }
    if (request.method === "GET") headers.set("Set-Cookie", `${HUB_COOKIE}=${options.credential}; Path=/; HttpOnly; SameSite=Strict`)
    headers.set("Content-Type", "text/html; charset=utf-8")
    return new Response(renderAccountPage(listed, notice), { headers })
  }
}
