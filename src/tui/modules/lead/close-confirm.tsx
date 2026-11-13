/** @jsxImportSource @opentui/solid */
import type { Accessor } from "solid-js"
import { Button } from "../../components/button.js"
import { ModalFrame } from "../../components/modal-frame.js"
import { ModalFooter } from "../../components/modal-footer.js"
import { useModalDimensions } from "../../hooks/use-modal-dimensions.js"
import { useTheme } from "../../context/theme.js"
import { LEAD_COMMAND } from "../../../protocol/modules/lead.js"

/** The focused control of the confirmation: Cancel first, so Enter on an
 *  unread dialog keeps the lead. */
export type LeadCloseFocus = "cancel" | "close"

/** Asks before the person closes the lead chat (PI-LEAD-008). */
export function LeadCloseConfirm(props: { focus: Accessor<LeadCloseFocus>; onCancel: () => void; onConfirm: () => void }) {
  const { theme } = useTheme()
  const { modalWidth } = useModalDimensions(60)
  return <ModalFrame title="Close lead" width={modalWidth()} onClose={props.onCancel}>
    <box flexDirection="column" paddingTop={1}>
      <text fg={theme.text} wrapMode="word">Close the lead chat?</text>
      <text fg={theme.textMuted} wrapMode="word">{`The chats that it started keep working. /${LEAD_COMMAND} opens the lead again.`}</text>
    </box>
    <box flexDirection="row" gap={1} paddingTop={1}>
      <Button label="Cancel" focused={props.focus() === "cancel"} onPress={props.onCancel} />
      <Button label="Close lead" focused={props.focus() === "close"} onPress={props.onConfirm} />
    </box>
    <box paddingTop={1}><ModalFooter rows={["←→/tab select · enter choose · esc cancel"]} /></box>
  </ModalFrame>
}
