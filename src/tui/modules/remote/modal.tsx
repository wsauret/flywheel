/** @jsxImportSource @opentui/solid */

import { StyledText, fg as stFg, link as stLink, underline as stUnderline, type ColorInput, type TextRenderable } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import type { TuiTheme } from "@tui/context/theme/resolve"
import { useModalDimensions } from "@tui/hooks/use-modal-dimensions"
import { useHoverHighlight } from "@tui/hooks/use-hover-highlight"
import { MODAL_FRAME_HORIZONTAL_INSET, ModalFrame } from "@tui/components/modal-frame"
import { ModalFooter } from "@tui/components/modal-footer"
import { ControlledTextField } from "@tui/components/controlled-text-field"
import { QrCode } from "@tui/components/qr-code"
import { useWrappedLineCount } from "@tui/utils/text"
import { qrCodeHeight, qrCodeWidth } from "../../../infra/qr-code.js"
import { createEffect, createMemo, Show } from "solid-js"
import { Key } from "@solid-primitives/keyed"
import { lingerNotice } from "../../../protocol/client/process-initiation-copy.js"
import type { RuntimeRemoteView } from "../../../protocol/modules/remote.js"
import type { RemoteRenameState } from "./use-remote-modal.js"
import { REMOTE_COMMAND_NAME } from "../../../protocol/modules/remote.js"

export interface RemoteModalProps {
  readonly view: RuntimeRemoteView | undefined
  readonly cursor: number
  readonly now: number
  readonly currentProjectRoot: string
  readonly rename: RemoteRenameState | undefined
  readonly processInitiationPending: boolean
  readonly renameSaving?: (deviceId: string) => boolean
  readonly onSelect: (index: number) => void
  readonly onClose: () => void
  readonly onRenameBlur?: () => void
}

/** Remote is one of two views. While a pairing window is open it is the code
 *  alone, because the code is the whole credential and the person is holding
 *  a phone up to it. Otherwise it is the remote state: first what keeps
 *  remote access from working, with its cause, then whether a phone can start
 *  Flywheel here, the paired phones, and the projects a phone can open.
 *  Every line shares one name column, so details read as one column too.
 *  Relay reachability is the composer border's reading, not repeated here. */

/** Rows the modal spends around the code while pairing: the frame and its
 *  offset from the screen edge, the title, the lead, the wrapped link, and
 *  the footer, with their spacing. */
const REMOTE_CONTROLS = ["p pair · r rename · d unpair · ↑↓ navigate · esc close", "c cancel · esc close", "p pair · esc close", "enter/esc done · tab back", "d stop offering · p pair · ↑↓ navigate · esc close"] as const
const PAIRING_CHROME_ROWS = 16
const INITIATION_LABEL = "Remote process initiation"
/** The cursor marker and its trailing space, before every name. */
const GUTTER = 2
const COLUMN_GAP = 3

export function RemoteModal(props: RemoteModalProps) {
  const wrappedLineCount = useWrappedLineCount()
  const { theme } = useTheme()
  const { modalWidth, listMaxHeight, termHeight } = useModalDimensions(80)
  const view = () => props.view
  const pairing = () => view()?.pairing ?? null
  const devices = () => view()?.devices ?? []
  const projects = () => view()?.projects ?? []
  // The width inside the frame's borders and side padding.
  const contentWidth = () => modalWidth() - MODAL_FRAME_HORIZONTAL_INSET
  // A code the terminal cannot show whole is not scannable, and a modal taller
  // than the screen hides its own footer; the link alone is then the way in.
  const codeFits = createMemo(() => {
    const window = pairing()
    return window !== null && qrCodeWidth(window.code) <= contentWidth() && qrCodeHeight(window.code) <= termHeight() - PAIRING_CHROME_ROWS
  })
  const remaining = createMemo(() => {
    const window = pairing()
    if (!window) return ""
    const seconds = Math.max(0, Math.round((window.expiresAt - props.now) / 1000))
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
  })
  // The problem starts after the gutter and wraps across the rest of the
  // content width, so a long cause shows whole. Its rows come out of the
  // list's height, so the modal stays within the screen and keeps its footer.
  const problemRows = createMemo(() => {
    const problem = view()?.lastError
    return problem ? wrappedLineCount(problem, contentWidth() - GUTTER) : 0
  })
  // The frame borders, the row padding, and the cursor gutter are what the
  // line cannot use.
  const rowWidth = () => modalWidth() - 5
  const nameWidth = createMemo(() => {
    const names = [...(view()?.processInitiation === undefined ? [] : [INITIATION_LABEL]), ...devices().map((device) => device.label), ...projects().map((project) => project.projectLabel)]
    return Math.min(Math.max(0, ...names.map((name) => name.length)) + COLUMN_GAP, Math.floor(rowWidth() / 2))
  })
  // The lingering notice starts after the gutter, where the Process initiation
  // label and the headings start. It wraps across the rest of the content
  // width, not in the detail column, so it takes few rows. Its rows come out
  // of the list's height, so the modal stays within the screen and keeps its
  // footer.
  const noticeRows = createMemo(() => {
    const user = view()?.lingerOffFor
    return user === undefined ? 0 : wrappedLineCount(lingerNotice(user), contentWidth() - GUTTER)
  })
  const footer = () => {
    if (pairing()) return REMOTE_CONTROLS[1]
    if (props.rename) return REMOTE_CONTROLS[3]
    const project = projects()[props.cursor - devices().length]
    const base = project?.projectRoot !== undefined && project.projectRoot !== props.currentProjectRoot
      ? REMOTE_CONTROLS[4]
      : devices().length > 0 ? REMOTE_CONTROLS[0] : REMOTE_CONTROLS[2]
    const initiation = view()?.processInitiation
    const action = props.processInitiationPending ? initiation === "unavailable" ? "repair in progress" : "change in progress" : initiation === "unavailable" ? "repair" : initiation === "on" ? "turn off" : "turn on"
    return initiation === undefined ? base : base.replace(" · esc close", ` · i ${action} · esc close`)
  }
  return (
    <ModalFrame title={REMOTE_COMMAND_NAME} width={modalWidth()} onClose={props.onClose} onMouseDown={props.onRenameBlur}>
      <box height={1} />
      <Show when={pairing()} fallback={
        <box flexDirection="column">
          <Show when={view()} fallback={<box paddingLeft={2}><text fg={theme.textMuted}>Loading remote state...</text></box>}>
            <Show when={view()?.lastError}>{(problem) =>
              <box paddingLeft={GUTTER}><text fg={theme.warning} wrapMode="word">{problem()}</text></box>
            }</Show>
            <Show when={view()?.processInitiation}>{(state) => <>
              <GridLine gutter=" " name={INITIATION_LABEL} detail={props.processInitiationPending ? `${state()} · ${state() === "unavailable" ? "repair" : "change"} in progress` : initiationReading(state())} nameWidth={nameWidth()} width={rowWidth()} theme={theme} nameColor={state() === "unavailable" ? theme.warning : undefined} detailColor={state() === "unavailable" ? theme.warning : undefined} />
              <Show when={view()?.lingerOffFor}>{(user) =>
                <box paddingLeft={GUTTER}><text fg={theme.warning} wrapMode="word">{lingerNotice(user())}</text></box>
              }</Show>
            </>}</Show>
            <Heading text="Devices" theme={theme} />
            <scrollbox maxHeight={Math.max(1, listMaxHeight() - 8 - noticeRows() - problemRows())} scrollbarOptions={{ visible: false }}>
              <Show when={devices().length > 0} fallback={<Note text="None paired. Press p to pair a phone." theme={theme} />}>
                <Key each={devices()} by="id">{(device, index) => (
                  <box selectable={false} backgroundColor={props.cursor === index() ? theme.backgroundElement : undefined} paddingLeft={2} paddingRight={1} onMouseDown={() => props.onSelect(index())}>
                    <Show when={props.rename?.deviceId === device().id ? props.rename : undefined} fallback={
                      <GridLine gutter={props.cursor === index() ? ">" : " "} name={device().label} detail={props.renameSaving?.(device().id) ? "Saving..." : deviceReading(device())} nameWidth={nameWidth()} width={rowWidth()} theme={theme} nameColor={props.cursor === index() ? theme.primary : theme.text} />
                    }>{(rename) => (
                      <box flexDirection="row" onMouseDown={(event) => event.stopPropagation()}>
                        <text fg={theme.primary}>{"> "}</text>
                        <ControlledTextField presentation={rename().presentation} focused width={nameWidth() - 1} textColor={theme.text} />
                        <text fg={rename().error ? theme.error : theme.textMuted} wrapMode="none" overflow="hidden">{" " + (rename().error ?? (rename().saving ? "Saving..." : deviceReading(device())))}</text>
                      </box>
                    )}</Show>
                  </box>
                )}</Key>
              </Show>
              <Heading text="Available projects" theme={theme} />
              <Show when={projects().length > 0} fallback={<Note text="None yet. Opening a project while a phone is paired offers it." theme={theme} />}>
                <Key each={projects()} by="placementId">{(project, index) => {
                  const rowIndex = () => devices().length + index()
                  const selected = () => project().projectRoot !== props.currentProjectRoot && props.cursor === rowIndex()
                  return (
                  <box backgroundColor={selected() ? theme.backgroundElement : undefined} paddingLeft={2} paddingRight={1} onMouseDown={() => props.onSelect(rowIndex())}>
                    <GridLine gutter={selected() ? ">" : " "} name={project().projectLabel} detail={`${project().state} · ${project().displayPath}`} nameWidth={nameWidth()} width={rowWidth()} theme={theme} nameColor={selected() ? theme.primary : theme.text} />
                  </box>
                  )
                }}</Key>
              </Show>
            </scrollbox>
          </Show>
        </box>
      }>{(window) => {
        const linkHover = useHoverHighlight()
        return (
          <box flexDirection="column" paddingLeft={2} paddingRight={2}>
            <text fg={theme.text}>Pair a phone</text>
            <text fg={theme.textMuted}>Scan with your phone's camera, or open the link on the phone. The code expires in {remaining()}.</text>
            <Show when={view()?.lastError}>{(error) => <text fg={theme.warning}>{error()}</text>}</Show>
            <box height={1} />
            <Show when={codeFits()} fallback={<text fg={theme.warning}>Enlarge the terminal to show the code, or open this link on the phone:</text>}>
              <QrCode text={window().code} />
            </Show>
            <box height={1} />
            <text
              ref={(el: TextRenderable) => {
                createEffect(() => {
                  const chunk = stLink(window().code)(stFg(linkHover.hovered() ? theme.primary : theme.textMuted)(window().code))
                  el.content = new StyledText([linkHover.hovered() ? stUnderline(chunk) : chunk])
                })
              }}
              {...linkHover.handlers}
              wrapMode="char"
            />
          </box>
        )
      }}</Show>
      <box paddingTop={1}><ModalFooter rows={[footer()]} /></box>
    </ModalFrame>
  )
}

/** Whether a phone can start a runtime here while nothing is running, and how to change that. */
function initiationReading(state: NonNullable<RuntimeRemoteView["processInitiation"]>): string {
  if (state === "unavailable") return "unavailable · press i to repair"
  return state === "on" ? "on · press i to turn off" : "off · press i to turn on"
}

function deviceReading(device: RuntimeRemoteView["devices"][number]): string {
  const paired = `paired ${new Date(device.pairedAt).toLocaleDateString()}`
  return device.attached ? `attached now · ${paired}` : paired
}

function Heading(props: { text: string; theme: TuiTheme }) {
  return <box paddingTop={1} paddingLeft={2}><text fg={props.theme.text}>{props.text}</text></box>
}

function Note(props: { text: string; theme: TuiTheme }) {
  return <box paddingLeft={2 + GUTTER}><text fg={props.theme.textMuted}>{props.text}</text></box>
}

/** One line of the shared grid: the gutter, the name padded to the name
 *  column, then the detail, cut to the row. */
function GridLine(props: { gutter: string; name: string; detail: string; nameWidth: number; width: number; theme: TuiTheme; nameColor?: ColorInput; detailColor?: ColorInput }) {
  const content = createMemo(() => {
    const name = props.name.length > props.nameWidth - 1 ? `${props.name.slice(0, props.nameWidth - 2)}…` : props.name
    const detail = props.detail.slice(0, Math.max(0, props.width - GUTTER - props.nameWidth))
    return new StyledText([
      stFg(props.nameColor ?? props.theme.text)(`${props.gutter} ${name.padEnd(props.nameWidth)}`),
      stFg(props.detailColor ?? props.theme.textMuted)(detail),
    ])
  })
  return <text ref={(element: TextRenderable) => { createEffect(() => { element.content = content() }) }} overflow="hidden" wrapMode="none" />
}
