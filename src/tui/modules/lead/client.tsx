/** @jsxImportSource @opentui/solid */
import { createContext, createMemo, createSignal, useContext, type Accessor } from "solid-js"
import { errorMessage } from "../../../infra/error-message.js"
import { leadCountLabel, leadLongestWaiting, leadRowOrder, type LeadRow } from "../../../protocol/modules/lead.js"
import type { ModalHandle } from "../../components/modal-stack.js"
import type { ModuleDomainIntakes } from "../../hooks/create-module-domain-intakes.js"
import type { TuiModuleClient, TuiModuleClientHost } from "../../tui-module-client.js"
import { LeadCloseConfirm, type LeadCloseFocus } from "./close-confirm.js"
import { openLeadReader, type LeadReaderHost } from "./reader.js"

/** What the lead's strip reads and opens, shared through the client's provider. */
export interface LeadScreen {
  /** The lead chat while it is the first tab; undefined when there is none. */
  readonly leadSessionId: Accessor<string | undefined>
  /** The rows in list order. */
  readonly rows: Accessor<readonly LeadRow[]>
  readonly title: (sessionId: string) => string
  /** Opens the reader on a row. Focus goes back to where it was when the reader closes. */
  readonly openReader: (row: LeadRow) => void
  /** Opens the reader on the chat that has waited longest; false when no chat waits. */
  readonly openLongestWaiting: () => boolean
}

const LeadScreenContext = createContext<LeadScreen>()

export function useLeadScreen(): LeadScreen {
  const screen = useContext(LeadScreenContext)
  if (!screen) throw new Error("the lead strip renders under the lead client's provider")
  return screen
}

type LeadClientHost = LeadReaderHost & Pick<TuiModuleClientHost, "dialog" | "title"> & { readonly domains: Pick<ModuleDomainIntakes, "lead"> }

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
  const openReader = (row: LeadRow): void => {
    openLeadReader(host, { row, title: () => title(row.sessionId), count: () => leadCountLabel(host.domains.lead.view()) })
  }
  const rows = createMemo(() => leadRowOrder(host.domains.lead.view()?.rows ?? []))
  const screen: LeadScreen = {
    leadSessionId: current,
    rows,
    title,
    openReader,
    openLongestWaiting: () => {
      const view = host.domains.lead.view()
      const row = view && leadLongestWaiting(view)
      if (row) openReader(row)
      return row !== undefined
    },
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
    openUri: async () => false,
    openSession: () => false,
    restore: async () => false,
    firstTab: {
      async open() {
        const result = await host.client.dispatch({ type: "lead.open", reason: "launch" })
        if (!result.ok) throw new Error(result.error)
        return result.sessionId ?? undefined
      },
      current,
    },
    closeGuard: (sessionId) => sessionId === current() ? confirmClose(sessionId) : Promise.resolve(true),
  }
}
