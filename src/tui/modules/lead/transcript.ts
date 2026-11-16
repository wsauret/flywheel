import type { CallStretchPresentation } from "../../../protocol/client/turn-folds.js"
import { CHECKPOINT_TOOL_NAMES } from "../../../infra/agent-assets/session-notes.js"
import { isLeadReportEntry } from "../../../protocol/modules/lead.js"
import { chatProgressDisplay, ROUTE_TO_NEW_CHAT, routeRequestDisplay } from "../../../infra/tools/displays/lead.js"

const chats = (count: number): string => count === 1 ? "1 chat" : `${count} chats`

/** The lead's tab in the terminal (PI-LEAD-017): its calls gather under one heading per stretch, the checkpoint calls
 *  are bookkeeping and never show, the heading says what the lead did with its chats, such as "checked chats, started
 *  1 chat", and a chat's report starts a turn that no person asked for, so it is a row of its own that ends the stretch
 *  before it (PI-LEAD-006). */
export const LEAD_TRANSCRIPT: CallStretchPresentation = {
  hidden: CHECKPOINT_TOOL_NAMES,
  startsTurn: isLeadReportEntry,
  phrases: (calls) => {
    const routes = calls.filter((call) => call.name === routeRequestDisplay.name)
    const started = routes.filter((call) => call.presentation.name === ROUTE_TO_NEW_CHAT).length
    const sent = routes.length - started
    return {
      phrases: [
        ...(calls.some((call) => call.name === chatProgressDisplay.name) ? ["checked chats"] : []),
        ...(started ? [`started ${chats(started)}`] : []),
        ...(sent ? [`sent to ${chats(sent)}`] : []),
      ],
      rest: calls.filter((call) => call.name !== routeRequestDisplay.name && call.name !== chatProgressDisplay.name),
    }
  },
}
