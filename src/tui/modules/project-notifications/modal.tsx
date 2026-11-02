/** @jsxImportSource @opentui/solid */

import type { ScrollBoxRenderable } from "@opentui/core"
import { createMemo, createSignal, Show } from "solid-js"
import { Key } from "@solid-primitives/keyed"
import { useListSelectionReveal } from "../../hooks/use-list-selection-reveal.js"
import { formatDateTime } from "../../../protocol/client/format.js"
import type { ProjectNotificationAction } from "../../../protocol/modules/project-notifications.js"
import { Button } from "../../components/button.js"
import { ModalFooter } from "../../components/modal-footer.js"
import { ModalFrame } from "../../components/modal-frame.js"
import { useTheme } from "../../context/theme.js"
import { useModalDimensions } from "../../hooks/use-modal-dimensions.js"
import { useWrappedLineCount } from "../../utils/text.js"
import type { TuiSurfaceProps } from "../../tui-module.js"
import { activateNotificationRow, dismissNotificationRow, notificationCursor, notificationNavigationRevision, selectNotificationRow, visibleRows } from "./list.js"
import { NOTIFICATIONS_COMMAND_NAME } from "../../../protocol/modules/project-notifications.js"

const ACTION_LABELS = {
  "open-auth": "Open Auth",
  "open-auth-provider": "Open Auth",
  "open-usage": "Open Usage",
  "open-settings": "Open Settings",
} satisfies { [Kind in ProjectNotificationAction["kind"]]: string }

/** The notifications surface: every visible episode with its optional action and
 *  a dismiss, the selected card kept in view. */
export function NotificationsModal(props: TuiSurfaceProps) {
  const wrappedLineCount = useWrappedLineCount()
  const { theme } = useTheme()
  const [scrollbox, setScrollbox] = createSignal<ScrollBoxRenderable>()
  // oxlint-disable-next-line solid/reactivity -- the surface's declared frame width is fixed for the modal's lifetime
  const { modalWidth, listMaxHeight } = useModalDimensions(props.width)
  const notifications = createMemo(() => visibleRows(props.read))
  const cursor = createMemo(() => notificationCursor(props.read))
  const rowHeights = createMemo(() => {
    const messageWidth = Math.max(1, modalWidth() - 8)
    return notifications()?.map((notification) => wrappedLineCount(notification.message, messageWidth) + 4) ?? []
  })
  const listHeight = createMemo(() => Math.min(rowHeights().reduce((total, height) => total + height, 0), listMaxHeight()))

  useListSelectionReveal({
    viewport: scrollbox,
    revision: notificationNavigationRevision,
    layout: () => [notifications(), modalWidth(), listMaxHeight()],
    elements: (scroll) => notifications()?.flatMap((row) => { const element = scroll.content.findDescendantById(row.id); return element ? [element] : [] }) ?? [],
    reveal: (scroll) => {
      const row = notifications()?.[cursor()]
      if (!row) return false
      scroll.scrollChildIntoView(row.id)
      return true
    },
  })

  return (
    <ModalFrame title={NOTIFICATIONS_COMMAND_NAME} width={modalWidth()} onClose={props.onClose}>
      <box height={1} />
      <Show when={notifications()} fallback={<text fg={theme.textMuted}>Loading notifications...</text>}>{(rows) =>
      <Show when={rows().length > 0} fallback={
        <box flexDirection="column" paddingLeft={2}>
          <text fg={theme.textMuted}>No notifications</text>
          <box height={1} />
          <text fg={theme.textMuted}>Esc closes.</text>
        </box>
      }>
        <scrollbox ref={(element: ScrollBoxRenderable) => setScrollbox(element)} height={listHeight()} maxHeight={listMaxHeight()} scrollbarOptions={{ visible: false }}>
          <Key each={rows()} by="id">
            {(notification, index) => (
              <box id={notification().id} flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1} backgroundColor={cursor() === index() ? theme.backgroundElement : undefined} onMouseDown={() => selectNotificationRow(index())}>
                <text overflow="hidden" wrapMode="none">
                  <span style={{ fg: notification().resolvedAt !== undefined ? theme.textMuted : notification().severity === "alert" ? theme.error : theme.warning }}>{`${notification().resolvedAt !== undefined ? "RESOLVED" : notification().severity.toUpperCase()}  `}</span>
                  <span style={{ fg: theme.text }}>{notification().title}</span>
                  <span style={{ fg: theme.textMuted }}>{`  ${formatDateTime(notification().createdAt)}`}</span>
                </text>
                <text fg={theme.textMuted}>{notification().message}</text>
                <box flexDirection="row" gap={2}>
                  <Show when={notification().action}>{(action) => (
                    <Button label={ACTION_LABELS[action().kind]} onPress={() => activateNotificationRow(props, index())} />
                  )}</Show>
                  <Button label="Dismiss" muted onPress={() => dismissNotificationRow(props, index())} />
                </box>
              </box>
            )}
          </Key>
        </scrollbox>
        <box paddingTop={1}><ModalFooter rows={props.controls} /></box>
      </Show>
      }</Show>
    </ModalFrame>
  )
}
