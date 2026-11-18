/** @jsxImportSource @opentui/solid */
import { basename } from "node:path"
import { createContext, createMemo, createSignal, useContext, type Accessor } from "solid-js"
import { errorMessage } from "../../../infra/error-message.js"
import { leadEntryLink, leadQuestionEntry, leadReportEntry, leadRowOrder, leadUpdateEntry, parseLeadEntryLink, sessionMessageCall, type LeadRow } from "../../../protocol/modules/lead.js"
import { truncateToWidth } from "../../utils/text.js"
import type { ModalHandle } from "../../components/modal-stack.js"
import type { ModuleDomainIntakes } from "../../hooks/create-module-domain-intakes.js"
import type { TuiModuleClient, TuiModuleClientHost } from "../../tui-module-client.js"
import { LeadCloseConfirm, type LeadCloseFocus } from "./close-confirm.js"
import { openLeadChatTab, openLeadChatViewer, type LeadChatViewerHost } from "./chat-viewer.js"
import { createLeadQuestionFocus, LeadQuestionWidget, type LeadQuestionFocus, type LeadQuestionHost } from "./question-widget.js"
import { LEAD_TRANSCRIPT } from "./transcript.js"

/** What the lead's strip reads and opens, shared through the client's provider. */
export interface LeadScreen {
  /** The lead chat while it is the first tab; undefined when there is none. */
  readonly leadSessionId: Accessor<string | undefined>
  /** The rows in list order. */
  readonly rows: Accessor<readonly LeadRow[]>
  /** The title that the chat's tab shows, so every place in the lead names a chat as its tab does (PI-LEAD-004); the
   *  full title for a chat with no short title, whose tab shows the start of it. */
  readonly title: (sessionId: string) => string
  /** The chat's longer title, or empty when it adds nothing to the tab title. */
  readonly longTitle: (sessionId: string) => string
  /** Opens a chat's full conversation over the lead, at `landing` when one is named. */
  readonly openChat: (sessionId: string, landing?: string) => void
  /** Opens a chat as an ordinary tab in front. */
  readonly openTab: (sessionId: string) => void
  /** Closes a chat as the Sessions list's close chat does, with no question first; its row leaves the list. */
  readonly closeChat: (sessionId: string) => void
  /** The key focus of the question widgets in the lead's transcript. */
  readonly questions: LeadQuestionFocus
}

const LeadScreenContext = createContext<LeadScreen>()

export function useLeadScreen(): LeadScreen {
  const screen = useContext(LeadScreenContext)
  if (!screen) throw new Error("the lead strip renders under the lead client's provider")
  return screen
}

/** The widest chat title that a report or update line shows, so the line stays one row with its open action on a
 *  terminal of 80 columns. */
const REPORT_TITLE_COLUMNS = 40

type LeadClientHost = LeadChatViewerHost & LeadQuestionHost & Pick<TuiModuleClientHost, "dialog" | "sessionTitles" | "closeChat"> & { readonly domains: Pick<ModuleDomainIntakes, "lead" | "leadChats"> }

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
  // Read now, so every place in the lead names a chat alike. A chat with no short title goes by its full title once,
  // which starts with what its tab shows, so its longer title is no repeat of the tab's cut of it.
  const title = (sessionId: string): string => { const row = host.sessionTitles(sessionId); return row ? row.shortTitle || row.title || row.id : "" }
  const longTitle = (sessionId: string): string => { const long = host.sessionTitles(sessionId)?.title ?? ""; return long === title(sessionId) ? "" : long }
  // The view's frame has room for both titles in one line.
  const viewerTitle = (sessionId: string): string => { const long = longTitle(sessionId); return long ? `${title(sessionId)} · ${long}` : title(sessionId) }
  const rows = createMemo(() => leadRowOrder(host.domains.leadChats.view()?.rows ?? []))
  const order = createMemo(() => rows().map((row) => row.sessionId))
  const rowOf = (sessionId: string): LeadRow | undefined => rows().find((candidate) => candidate.sessionId === sessionId)
  const closeChat = (sessionId: string): void => {
    void host.closeChat(sessionId).catch((cause: unknown) => { report(`Close failed for ${title(sessionId) || sessionId}: ${errorMessage(cause)}`) })
  }
  const screen: LeadScreen = {
    leadSessionId: current,
    rows,
    title,
    longTitle,
    openChat: (sessionId, landing) => { openLeadChatViewer(host, { sessionId, order, row: rowOf, title: viewerTitle, closeChat, ...(landing === undefined ? {} : { landing }) }) },
    openTab: (sessionId) => { openLeadChatTab(host, sessionId, rowOf(sessionId)) },
    closeChat,
    questions: createLeadQuestionFocus(),
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
    provide: (children) => <LeadScreenContext.Provider value={screen}>{children()}</LeadScreenContext.Provider>,
    openUri: async (uri) => {
      const opened = parseLeadEntryLink(uri)
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
      // A message from a chat is one line that opens the chat where it sent it (PI-LEAD-006): a report, which the
      // runtime posted, at the final message, a question, which the runtime posted, at its call with the question's
      // widget below the line (PI-LEAD-005), an update, which the runtime posted, at the chat's newest interim text
      // (PI-LEAD-021), and a message that the chat sent itself at its call.
      messageRow: (message) => {
        const call = sessionMessageCall(message)
        if (call === undefined) return undefined
        const chat = message.from.sessionId
        const question = leadQuestionEntry(message)
        const reportEntry = leadReportEntry(message)
        return {
          name: question !== undefined ? "Question" : reportEntry === undefined ? "Update" : "Report",
          detail: `· ${truncateToWidth(title(chat) || message.from.name, REPORT_TITLE_COLUMNS, "…")} · open`,
          linkUri: leadEntryLink(chat, reportEntry ?? question ?? leadUpdateEntry(message) ?? call),
          ...(question === undefined ? {} : { below: (ready: () => void) => <LeadQuestionWidget sessionId={chat} toolUseId={question} host={host} focus={screen.questions} ready={ready} /> }),
        }
      },
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
