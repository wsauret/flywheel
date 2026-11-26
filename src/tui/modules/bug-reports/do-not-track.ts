import { createEffect, on, untrack } from "solid-js"
import { doNotTrack } from "../../../infra/environment/do-not-track.js"
import { AUTOMATIC_REPORTS_CONTROL, AUTOMATIC_REPORTS_SETTING } from "../../../protocol/modules/bug-reports.js"
import type { TuiPresenceProps } from "../../tui-module.js"

const DO_NOT_TRACK_TURNED_OFF_NOTICE = `Automatic crash reports are now off because DO_NOT_TRACK is set. To change this, open ${AUTOMATIC_REPORTS_SETTING} in Settings.`

/** Turns the saved yes to automatic crash reports into no when this terminal starts with DO_NOT_TRACK set.
 *  The account service that sends reports of its own faults runs in the service manager's environment, so it
 *  cannot see a DO_NOT_TRACK that only this terminal's shell or command line sets; the saved answer reaches it.
 *  It decides once, when both the module selection and the configuration are first published, and writes as the
 *  Settings row writes. An unanswered or no answer, a disabled module, and an unset DO_NOT_TRACK change nothing. */
export function presentDoNotTrack(props: TuiPresenceProps, environment: NodeJS.ProcessEnv = process.env): void {
  if (!doNotTrack(environment.DO_NOT_TRACK)) return
  let decided = false
  createEffect(on(() => [props.enabled(), props.settings.configBoolean(AUTOMATIC_REPORTS_CONTROL)] as const, ([enabled, automatic]) => {
    if (decided || enabled === undefined || automatic === undefined) return
    decided = true
    if (!enabled || !automatic) return
    void untrack(() => props.settings.updateConfigBoolean(AUTOMATIC_REPORTS_CONTROL, false)).then((result) => {
      props.showToast(result.ok
        ? { message: DO_NOT_TRACK_TURNED_OFF_NOTICE, variant: "info", duration: 10000 }
        : { message: `DO_NOT_TRACK is set, but Flywheel could not turn off ${AUTOMATIC_REPORTS_SETTING}: ${result.error.message}`, variant: "warning", duration: 10000 })
    })
  }))
}
