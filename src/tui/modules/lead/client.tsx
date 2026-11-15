/** @jsxImportSource @opentui/solid */
import { basename } from "node:path"
import { createContext, createMemo, createSignal, useContext, type Accessor } from "solid-js"
import { errorMessage } from "../../../infra/error-message.js"
import { leadReportEntry, leadReportLink, leadRowOrder, parseLeadReportLink, type LeadRow } from "../../../protocol/modules/lead.js"
import { MessageRowProvider } from "../../context/message-row.js"
import { truncateToWidth } from "../../utils/text.js"
import type { ModalHandle } from "../../components/modal-stack.js"
import type { ModuleDomainIntakes } from "../../hooks/create-module-domain-intakes.js"
import type { TuiModuleClient, TuiModuleClientHost } from "../../tui-module-client.js"
import { LeadCloseConfirm, type LeadCloseFocus } from "./close-confirm.js"
import { openLeadChatTab, openLeadChatViewer, type LeadChatViewerHost } from "./chat-viewer.js"
import { LEAD_TRANSCRIPT } from "./transcript.js"

/** What the lead's strip reads and opens, shared through the client's provider. */
export interface LeadScreen {
  /** The lead chat while it is the first tab; undefined when there is none. */
  readonly leadSessionId: Accessor<string | undefined>
  /** The rows in list order. */
  readonly rows: Accessor<readonly LeadRow[]>
  readonly title: (sessionId: string) => string
  /** Opens a chat's full conversation over the lead, at `landing` when one is named. */
  readonly openChat: (sessionId: string, landing?: string) => void
  /** Opens a chat as an ordinary tab in front. */
  readonly openTab: (sessionId: string) => void
}

const LeadScreenContext = createContext<LeadScreen>()

export function useLeadScreen(): LeadScreen {
  const screen = useContext(LeadScreenContext)
  if (!screen) throw new Error("the lead strip renders under the lead client's provider")
  return screen
}

/** The widest chat title that a report line shows, so the line stays one row with its open action on a terminal of 80
 *  columns. */
const REPORT_TITLE_COLUMNS = 40

type LeadClientHost = LeadChatViewerHost & Pick<TuiModuleClientHost, "dialog" | "title"> & { readonly domains: Pick<ModuleDomainIntakes, "lead" | "leadChats"> }

/** The terminal title of the lead's tab (PI-LEAD-009): Flywheel and the project's directory name, such as
 *  "Flywheel | Data", because the lead chat's own title names no project. */
function leadTerminalTitle(projectRoot: string): string {
  const project = basename(projectRoot) || projectRoot
  return project ? `Flywheel | ${project.charAt(0).toUpperCase()}${project.slice(1)}` : "Flywheel"
}

/** The lead's terminal client: the lead chat is the first tab while the
 *  capability is on and the person has not dismissed it, and closing it asks
 *  first. A module that is off answers the empty view, so its tab goes. */
export function createLeadClient(host: LeadClientHost): TuiModuleClient {
  const current = createMemo(() => {
    const view = host.domains.lead.view()
    return view && !view.dismissed ? view.leadSessionId ?? undefined : undefined
  })
  const report = (message: string): void => { host.showToast({ message, variant: "error" }) }
  const title = (sessionId: string): string => host.title(sessionId) ?? ""
  const rows = createMemo(() => leadRowOrder(host.domains.leadChats.view()?.rows ?? []))
  const order = createMemo(() => rows().map((row) => row.sessionId))
  const rowOf = (sessionId: string): LeadRow | undefined => rows().find((candidate) => candidate.sessionId === sessionId)
  const screen: LeadScreen = {
    leadSessionId: current,
    rows,
    title,
    openChat: (sessionId, landing) => { openLeadChatViewer(host, { sessionId, order, row: rowOf, title, ...(landing === undefined ? {} : { landing }) }) },
    openTab: (sessionId) => { openLeadChatTab(host, sessionId, rowOf(sessionId)) },
  }

  /** Answers true once the person confirms, after it starts the dismissal and
   *  without a wait for it: the caller closes the tab before the dismissal
   *  arrives, so the tab closes as a closed tab and its chat closes at rest. */
  function confirmClose(sessionId: string): Promise<boolean> {
    return new Promise((resolve) => {
      const [focus, setFocus] = createSignal<LeadCloseFocus>("cancel")
      const settle = (allowed: boolean): void => { resolve(allowed); handle.close() }
      const cancel = (): void => { settle(false) }
      const confirm = (): void => {
        void host.client.dispatch({ type: "lead.dismiss", sessionId }).then((result) => { if (!result.ok) report(result.error) }, (cause: unknown) => { report(errorMessage(cause)) })
        settle(true)
      }
      const handle: ModalHandle = host.dialog.push(() => <LeadCloseConfirm focus={focus} onCancel={cancel} onConfirm={confirm} />, {
        onClose: cancel,
        onKey: (event) => {
          event.preventDefault?.()
          if (event.name === "escape") cancel()
          else if (event.name === "left" || event.name === "right" || event.name === "tab") setFocus((held) => held === "cancel" ? "close" : "cancel")
          else if (event.name === "return" || event.name === "enter") { if (focus() === "close") confirm(); else cancel() }
        },
      })
    })
  }

  return {
    // A report is a message from a chat that the runtime posted to the lead (PI-LEAD-006): its row is one line that
    // opens the chat at the final message.
    provide: (children) => <LeadScreenContext.Provider value={screen}><MessageRowProvider present={(message) => {
      const entryId = leadReportEntry(message)
      return entryId === undefined ? undefined : { name: "Report", detail: `· ${truncateToWidth(message.from.name, REPORT_TITLE_COLUMNS, "…")} · open`, linkUri: leadReportLink(message.from.sessionId, entryId) }
    }}>{children()}</MessageRowProvider></LeadScreenContext.Provider>,
    openUri: async (uri) => {
      const opened = parseLeadReportLink(uri)
      if (!opened) return false
      screen.openChat(opened.sessionId, opened.entryId)
      return true
    },
    openSession: () => false,
    restore: async () => false,
    firstTab: {
      async open() {
        const result = await host.client.dispatch({ type: "lead.open", reason: "launch" })
        if (!result.ok) throw new Error(result.error)
        return result.sessionId === null ? undefined : { sessionId: result.sessionId, row: result.row, created: result.created }
      },
      current,
      terminalTitle: leadTerminalTitle,
      transcript: LEAD_TRANSCRIPT,
      // The lead is the happy path and tabs the divergent one (PI-LEAD-013, PI-LEAD-014).
      hidesTabControls: true,
    },
    closeGuard: (sessionId) => sessionId === current() ? confirmClose(sessionId) : Promise.resolve(true),
    // The lead command reopens a dismissed lead, so the Sessions list never shows it (PI-LEAD-010).
    sessionNavigation: {
      hidden: () => { const lead = host.domains.lead.view()?.leadSessionId; return lead ? [lead] : [] },
      over: current,
      open: (sessionId) => { screen.openChat(sessionId) },
    },
  }
}
