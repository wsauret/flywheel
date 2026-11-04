/** @jsxImportSource @opentui/solid */

import { StyledText, bold as stBold, fg as stFg, type TextRenderable } from "@opentui/core"
import { useKeymap } from "@tui/context/keymap"
import { useTheme } from "@tui/context/theme"
import type { TuiTheme } from "@tui/context/theme/resolve.js"
import { createEffect, createMemo, Show, type Accessor, untrack } from "solid-js"
import { Key } from "@solid-primitives/keyed"
import { displayWidth } from "./utils/text.js"
import { fontTipMessage } from "../orchestration/font-installer.js"
import { collapseHome } from "../infra/home-path.js"
import type { ModuleRow } from "../protocol/protocol-module.js"
import { formatRuntimeIdentity, type RuntimeIdentity } from "../protocol/client/runtime-identity.js"
import { Button } from "./components/button.js"
import { startupTrace } from "../infra/startup-trace.js"
import { NO_PROVIDER_READY } from "../protocol/client/provider-setup.js"
import type { ReleaseNotice } from "../protocol/update-protocol-types.js"
import { stLink } from "./utils/text-attributes.js"

/** The boot-trace phase the release startup gate reads as part of "ready":
 *  the first intro card this process shows with its complete title. */
const SESSION_INTRO_VISIBLE_PHASE = "session intro visible"
let introVisibilityTraced = false

const CARD_MAX_WIDTH = 62
const CARD_CHROME_WIDTH = 4
const LABEL_WIDTH = "directory:".length

export interface SessionIntroProps {
  /** The serving backend's identity; undefined until the attach or a snapshot names it. */
  runtimeIdentity: Accessor<RuntimeIdentity | undefined>
  /** The project's Show build setting. */
  showBuild: Accessor<boolean>
  /** Project identity: the directory that owns this project's durable state,
   *  on the machine that runs it, as the runtime names it. */
  projectRoot: Accessor<string>
  /** Startup-selected account home the project path is shown relative to. */
  accountHome: string
  /** Startup-selected account data root containing bundled font assets. */
  userDataRoot: string
  fontTipDismissed: Accessor<boolean>
  /** Live branch of this session's execution directory. */
  branchName: Accessor<string | undefined>
  sessionKind: Accessor<"chat" | "subagent" | "workflow-agent">
  modelLabel: Accessor<string | undefined>
  tabsHintDismissed: Accessor<boolean>
  onDismissTabsHint: () => void
  releaseNotice?: { readonly notice: Accessor<ReleaseNotice | undefined>; readonly dismiss: () => void }
  /** The auth profile the card names, or undefined when the card leaves the
   *  profile line out: before the runtime publishes it, or while only one
   *  profile exists. */
  profileName: Accessor<string | undefined>
  /** The rows every module contributes, rendered after the kernel rows. */
  moduleRows: Accessor<readonly ModuleRow[]>
  availableWidth: Accessor<number>
  noProviderReady?: () => boolean
}

export function SessionIntroBlock(props: SessionIntroProps) {
  const themeCtx = useTheme()
  const { chordFor } = useKeymap().keymap
  // The one orienting sentence about the session model, shown until dismissed;
  // everything else about tabs is taught by the chrome and by /clear.
  const tabsHint = () => `Each tab is one session: ${chordFor("new")} opens a fresh one, ${chordFor("tab.close")} closes it.`
  const tip = createMemo(() => fontTipMessage(props.fontTipDismissed(), untrack(() => ({ accountHome: props.accountHome, userDataRoot: props.userDataRoot }))))
  const cardWidth = createMemo(() => Math.max(1, Math.min(CARD_MAX_WIDTH, props.availableWidth())))
  const innerWidth = createMemo(() => Math.max(0, cardWidth() - CARD_CHROME_WIDTH))
  const title = createMemo(() => titleContent(formatRuntimeIdentity(props.runtimeIdentity(), props.showBuild()), themeCtx.theme))
  const directory = createMemo(() =>
    rowContent("project:", formatDirectory(props.projectRoot(), props.accountHome, valueWidth(innerWidth())), themeCtx.theme)
  )
  const branch = createMemo(() => rowContent("branch:", fitEnd(props.branchName() ?? "", valueWidth(innerWidth())), themeCtx.theme))
  // Once per process: after the phase fires, the effect reads no signal and never reruns.
  if (!introVisibilityTraced) createEffect(() => {
    if (introVisibilityTraced || props.runtimeIdentity() === undefined) return
    introVisibilityTraced = true
    startupTrace(SESSION_INTRO_VISIBLE_PHASE)
  })
  return (
    <box flexDirection="column" paddingLeft={1} paddingTop={1} gap={1}>
      <box
        flexDirection="column"
        border={["top", "bottom", "left", "right"]}
        borderStyle="rounded"
        borderColor={themeCtx.theme.border}
        paddingLeft={1}
        paddingRight={1}
        width={cardWidth()}
      >
        <StyledLine content={title} wrap />
        <text> </text>
        <Show when={props.modelLabel()} keyed>
          {(label) => <StyledLine content={() => commandRowContent("model:", label, "/model", "to change", innerWidth(), themeCtx.theme)} />}
        </Show>
        <StyledLine content={directory} />
        {props.branchName() === undefined ? null : <StyledLine content={branch} />}
        <Show when={props.profileName()} keyed>
          {(name) => <StyledLine content={() => commandRowContent("profile:", name, "/settings", "to change", innerWidth(), themeCtx.theme)} />}
        </Show>
        <Key each={props.moduleRows()} by="id">
          {(row) => <StyledLine content={() => moduleRowContent(row(), innerWidth(), themeCtx.theme)} />}
        </Key>
      </box>
      <Show when={props.releaseNotice?.notice()}>
        {(notice) => (
          <box flexDirection="row" gap={1} width={cardWidth()}>
            <box flexDirection="column" flexGrow={1} flexShrink={1}>
              <StyledLine content={() => new StyledText([stFg(themeCtx.theme.text)(stBold(notice().message))])} wrap />
              <StyledLine content={() => new StyledText([
                stFg(themeCtx.theme.textMuted)(stLink(notice().url)(notice().url)),
                stFg(themeCtx.theme.textMuted)(" for details"),
              ])} wrap />
            </box>
            <Button label="x" muted onPress={() => props.releaseNotice?.dismiss()} />
          </box>
        )}
      </Show>
      {props.tabsHintDismissed() ? null : (
        <box flexDirection="row" gap={1} width={cardWidth()}>
          <text fg={themeCtx.theme.textMuted} flexGrow={1} flexShrink={1} wrapMode="word">{tabsHint()}</text>
          <Button label="x" muted onPress={props.onDismissTabsHint} />
        </box>
      )}
      {props.noProviderReady?.() === true ? (
        <text fg={themeCtx.theme.warning} width={cardWidth()} wrapMode="word">{`${NO_PROVIDER_READY}; run \`/auth\` to set one up.`}</text>
      ) : null}
      {tip() ? (
        <text fg={themeCtx.theme.textMuted} width={cardWidth()} wrapMode="word">{tip()}</text>
      ) : null}
    </box>
  )
}

function StyledLine(props: { content: Accessor<StyledText>; wrap?: boolean }) {
  return (
    <text
      ref={(el: TextRenderable) => {
        createEffect(() => { el.content = props.content() })
      }}
      overflow="hidden"
      wrapMode={props.wrap ? "word" : "none"}
    />
  )
}

function titleContent(identity: string | undefined, theme: TuiTheme): StyledText {
  return new StyledText([
    stFg(theme.textMuted)(">_ "),
    stBold(stFg(theme.text)("Flywheel")),
    ...(identity === undefined ? [] : [stFg(theme.textMuted)(` (${identity})`)]),
  ])
}

/** A card row whose value is followed by a "/command verb" affordance. */
function commandRowContent(label: string, value: string, command: string, verb: string, width: number, theme: TuiTheme, valueColor: TuiTheme["text"] = theme.text): StyledText {
  const prefix = labelPrefix(label)
  const suffix = verb.length === 0 ? "" : ` ${verb}`
  const fixedWidth = displayWidth(prefix) + displayWidth("   ") + displayWidth(command) + displayWidth(suffix)
  const visibleValue = fitEnd(value, width - fixedWidth)
  return new StyledText([
    stFg(theme.textMuted)(prefix),
    stFg(valueColor)(visibleValue),
    stFg(theme.textMuted)("   "),
    stFg(theme.primary)(command),
    ...(suffix.length === 0 ? [] : [stFg(theme.textMuted)(suffix)]),
  ])
}

/** A module's row in the card's own grammar: a command action renders as the
 *  kernel's command rows do, anything else as a value with a muted hint. */
function moduleRowContent(row: ModuleRow, width: number, theme: TuiTheme): StyledText {
  const label = `${row.label}:`
  const valueColor = row.tone === "warning" ? theme.warning : theme.text
  if (row.action?.kind === "command") return commandRowContent(label, row.value, `/${row.action.id}`, row.hint ?? "", width, theme, valueColor)
  const prefix = labelPrefix(label)
  const hint = row.hint === undefined ? "" : `   ${row.hint}`
  const visibleValue = fitEnd(row.value, width - displayWidth(prefix) - displayWidth(hint))
  return new StyledText([
    stFg(theme.textMuted)(prefix),
    stFg(valueColor)(visibleValue),
    ...(hint.length === 0 ? [] : [stFg(theme.textMuted)(hint)]),
  ])
}

function rowContent(label: string, value: string, theme: TuiTheme): StyledText {
  return new StyledText([
    stFg(theme.textMuted)(labelPrefix(label)),
    stFg(theme.text)(value),
  ])
}

function labelPrefix(label: string): string {
  return `${label.padEnd(LABEL_WIDTH)} `
}

function valueWidth(innerWidth: number): number {
  return innerWidth - displayWidth(labelPrefix("directory:"))
}

function formatDirectory(directory: string, home: string, maxWidth: number): string {
  const formatted = abbreviatePath(collapseHome(directory, home))
  if (displayWidth(formatted) <= maxWidth) return formatted
  return fitEnd(formatted, maxWidth)
}

function abbreviatePath(inputPath: string): string {
  const separator = inputPath.includes("\\") ? "\\" : "/"
  const parts = inputPath.split(/[\\/]/)
  if (parts.length <= 4) return inputPath
  const first = parts.slice(0, 2).join(separator)
  const last = parts.slice(-2).join(separator)
  return `${first}${separator}…${separator}${last}`
}

function fitEnd(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ""
  if (displayWidth(text) <= maxWidth) return text
  if (maxWidth === 1) return "…"
  let out = ""
  for (const char of text) {
    if (displayWidth(`${out}${char}…`) > maxWidth) break
    out += char
  }
  return `${out}…`
}
