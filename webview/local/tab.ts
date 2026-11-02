import { brandTileSvg } from "../../src/protocol/client/brand.js"
import type { ClientSummary } from "../../src/protocol/client/host-contract.js"

/** What the tab says about the project at a glance: the session is working,
 *  the page has lost the runtime, or neither. */
export type TabState = "idle" | "working" | "away"

const BADGE = { working: "#89d185", away: "#8b8b8b" }
const PRODUCT = "Flywheel"

export function tabState(summary: Pick<ClientSummary, "health" | "busy">): TabState {
  // A connection that drops and heals earns nothing: only a runtime the client
  // has given up reaching for now marks the tab, and the mark lifts on its own.
  if (summary.health.kind === "faulted") return "away"
  return summary.busy ? "working" : "idle"
}

/** The tab's title: the session first, because a person with several project
 *  tabs open reads the session name, and the product last as the family name.
 *  A working session and a page that has lost the runtime say so up front,
 *  where a truncated tab still shows it. */
export function tabTitle(sessionTitle: string | undefined, state: TabState): string {
  const parts = [sessionTitle, PRODUCT].filter((part) => part !== undefined && part.length > 0)
  if (state === "working") return `Working · ${parts.join(" · ")}`
  if (state === "away") return `Runtime lost · ${parts.join(" · ")}`
  return parts.join(" · ")
}

/** The tab's icon: the brand tile, with a dot in the corner while the session
 *  works, greyed while the page has lost the runtime. Drawn at tab size so the
 *  badge stays a readable share of the icon. */
export function faviconSvg(state: TabState): string {
  const tile = brandTileSvg(64, { corners: "rounded" })
  if (state === "idle") return tile
  const badge = state === "working"
    ? `<circle cx="52" cy="52" r="11" fill="${BADGE.working}" stroke="#1c1b19" stroke-width="4"/>`
    : `<rect width="64" height="64" fill="#1c1b19" fill-opacity="0.55"/><circle cx="52" cy="52" r="11" fill="${BADGE.away}" stroke="#1c1b19" stroke-width="4"/>`
  return tile.replace("</svg>", `${badge}</svg>`)
}

export function faviconHref(state: TabState): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(faviconSvg(state))}`
}

/** A tab that navigates away can keep its page alive in the browser's
 *  back-forward cache with the socket open, and that socket holds the project
 *  open. The page lets its connection go when it is hidden, and loads again
 *  when the browser shows it again from that cache. */
export function releaseWhileCached(page: Pick<EventTarget, "addEventListener">, release: () => void, reload: () => void): void {
  page.addEventListener("pagehide", release)
  page.addEventListener("pageshow", (event) => {
    if ("persisted" in event && event.persisted === true) reload()
  })
}

/** Paints the tab from one client summary: title and icon together, so the
 *  two never disagree about the session's state. */
export function applyTabIdentity(document: Document, summary: Pick<ClientSummary, "health" | "busy" | "sessionTitle">): void {
  const state = tabState(summary)
  document.title = tabTitle(summary.sessionTitle, state)
  document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.setAttribute("href", faviconHref(state))
}
