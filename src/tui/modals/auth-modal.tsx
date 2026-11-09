/** @jsxImportSource @opentui/solid */

import { type ScrollBoxRenderable, StyledText, bold as stBold, fg as stFg, link as stLink, type TextRenderable } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import type { TuiTheme } from "@tui/context/theme/resolve"
import { useModalDimensions } from "@tui/hooks/use-modal-dimensions"
import { ModalFrame } from "@tui/components/modal-frame"
import { createEffect, createMemo, createSignal, For, Index, Match, on, onCleanup, Show, Switch, type Accessor } from "solid-js"
import { ControlledTextField } from "../components/controlled-text-field.js"
import type { TextEditorPresentation } from "../keymap/text-entry.js"
import { filterProviderModelRows, providerModelsCanDeselect, soleAccount, type AuthRow, type AuthView } from "../hooks/auth-modal-options.js"
import type { DisconnectConfirmation } from "../hooks/auth-modal-disconnect.js"
import type { RuntimeAuthLoginPrompt } from "../../protocol/auth-login-protocol-types.js"
import type { AuthAccountAttention, AuthProviderAttention, AuthProviderSource, RuntimeAuthLoginQuestion } from "../../protocol/auth-status-protocol-types.js"
import { accountStatusInput } from "../../protocol/client/auth-status-state.js"
import { REPLACING_FREE_PLAN } from "../../protocol/client/auth-login.js"
import { accountTitle, BROWSER_LOGIN_COPY, disconnectConsequence, LOGIN_QUESTION_COPY, paidUseEvidence } from "../../protocol/client/provider-account-copy.js"
import type { ProviderCatalogDiscovery, ProviderModelRow } from "../../protocol/provider-model-preference-protocol-types.js"
import { authStatusPresentation } from "../auth-status-presentation.js"
import { ModalFooter } from "../components/modal-footer.js"
import { Facts, Section, type Fact } from "../components/modal-section.js"
import { Button } from "../components/button.js"
import { AUTH_CONTROL_COPY, AUTH_LIST_ACTION_COPY, MODAL_FRAME_WIDTHS, SUBSCRIPTION_SPEND_CONSENT_COPY } from "../components/modal-copy.js"
import type { SubscriptionSpendConsentControlState } from "../hooks/use-subscription-spend-consent-control.js"
import { CONSENT_ACTION_CURSOR } from "../hooks/use-subscription-spend-consent-modal.js"
import { paidUseQuestionFooterRows, paidUseQuestionLines, subscriptionSpendConsentDetail, subscriptionSpendFooterRows, subscriptionSpendWarnsPrepaid } from "./subscription-spend-consent-modal.js"
import { displayWidth, truncateToWidth } from "../utils/text.js"
import { providerCatalogRequiresReconnect, providerCatalogStatusText } from "./provider-catalog-text.js"
import { useKeyedListScroll } from "../hooks/use-keyed-list-scroll.js"
import { BOLD } from "../utils/text-attributes.js"
import { KERNEL_COMMAND_NAMES } from "../../protocol/command-names.js"

function apiKeyPlaceholder(prefix: string | undefined): string {
  return prefix === undefined ? "API key" : `${prefix}....`
}

interface AuthModalProps {
  view: AuthView
  /** A Disconnect that waits on the person's answer, shown in place of the view. */
  disconnect?: DisconnectConfirmation | undefined
  profileAttemptPending?: boolean
  rows: AuthRow[]
  cursor: number
  inputPresentation: TextEditorPresentation
  consent?: Accessor<SubscriptionSpendConsentControlState>
  onSelect: (index: number) => void
  onSelectModel?: (index: number) => void
  onRecheckModels?: () => void
  onClose: () => void
  onRenameBlur?: () => void
  onToggleConsent?: (envelopeId: string) => void
  onOpenModels?: () => void
  onToggleFreeRoutes?: () => void
  onContinueConsent?: () => void
  onConfirmDisconnect?: () => void
  onCancelDisconnect?: () => void
  onAnswerLoginQuestion: (login: boolean) => void
  onAnswerLoginConfirmation?: (replace: boolean) => void
}

export function AuthModal(props: AuthModalProps) {
  const { modalWidth, listMaxHeight } = useModalDimensions(MODAL_FRAME_WIDTHS.auth)

  return (
    <ModalFrame title={props.disconnect === undefined ? viewTitle(props.view) : `${AUTH} › Disconnect`} width={modalWidth()} onClose={() => props.onClose()} onMouseDown={props.onRenameBlur}>
      <box height={1} />
      <Show when={props.disconnect} fallback={<Switch>
        <Match when={props.view.kind === "login-question" ? props.view : undefined}>
          {(v) => <LoginQuestionView view={v()} onAnswer={props.onAnswerLoginQuestion} />}
        </Match>
        <Match when={props.view.kind === "login-confirmation" ? props.view : undefined}>
          {(v) => <LoginConfirmationView view={v()} onAnswer={props.onAnswerLoginConfirmation ?? (() => {})} />}
        </Match>
        <Match when={props.view.kind === "list"}>
          <ProviderList rows={props.rows} cursor={props.cursor} maxHeight={listMaxHeight()} rowWidth={modalWidth() - 9} onSelect={props.onSelect} />
          <box paddingTop={1}>
            <ModalFooter rows={listFooter(props.rows, props.cursor)} />
          </box>
        </Match>
        <Match when={props.view.kind === "provider-models" ? props.view : undefined}>
          {(v) => <ProviderModelsView view={v()} presentation={props.inputPresentation} width={Math.max(1, modalWidth() - 10)} maxHeight={listMaxHeight()} onSelect={props.onSelectModel ?? (() => {})} onRecheck={props.onRecheckModels ?? (() => {})} />}
        </Match>
        <Match when={props.view.kind === "provider-settings" ? props.view : undefined}>
          {(v) => <ProviderSettingsView view={v()} consent={props.consent?.()} onOpenModels={props.onOpenModels ?? (() => {})} onToggleFreeRoutes={props.onToggleFreeRoutes ?? (() => {})} onToggle={props.onToggleConsent ?? (() => {})} />}
        </Match>
        <Match when={props.view.kind === "paid-use-question" ? props.view : undefined}>
          {(v) => <PaidUseQuestionView view={v()} consent={props.consent?.()} onToggle={props.onToggleConsent ?? (() => {})} onContinue={props.onContinueConsent ?? (() => {})} />}
        </Match>
        <Match when={props.view.kind === "api-key-input" ? props.view : undefined}>
          {(v) => <ApiKeyInputView presentation={props.inputPresentation} keyPrefix={v().keyPrefix} label={v().label} width={Math.max(1, modalWidth() - 10)} />}
        </Match>
        <Match when={props.view.kind === "login-prompt" ? props.view : undefined}>
          {(v) => <LoginPromptView presentation={props.inputPresentation} prompt={v().prompt} width={Math.max(1, modalWidth() - 10)} />}
        </Match>
        <Match when={props.view.kind === "rename-input" ? props.view : undefined}>
          {(v) => <RenameInputView presentation={props.inputPresentation} label={v().label} saving={v().saving} width={Math.max(1, modalWidth() - 10)} />}
        </Match>
        <Match when={props.view.kind === "profile-create-input" ? props.view : undefined}>
          {(v) => <ProfileInputView presentation={props.inputPresentation} label="Create Profile" error={v().error} saving={v().saving} width={Math.max(1, modalWidth() - 10)} />}
        </Match>
        <Match when={props.view.kind === "profile-rename-input" ? props.view : undefined}>
          {(v) => <ProfileInputView presentation={props.inputPresentation} label={`Rename ${v().label}`} renaming error={v().error} saving={v().saving} width={Math.max(1, modalWidth() - 10)} />}
        </Match>
        <Match when={props.view.kind === "profile-delete-confirmation" ? props.view : undefined}>
          {(v) => <ProfileDeleteConfirmationView view={v()} pending={props.profileAttemptPending === true} maxHeight={listMaxHeight()} />}
        </Match>
        <Match when={props.view.kind === "device-code" ? props.view : undefined}>
          {(v) => <DeviceCodeView userCode={v().userCode} url={v().url} question={v().question} />}
        </Match>
        <Match when={props.view.kind === "browser-auth" ? props.view : undefined}>
          {(v) => <BrowserAuthView view={v()} presentation={props.inputPresentation} width={Math.max(1, modalWidth() - 10)} />}
        </Match>
      </Switch>}>
        {(confirmation) => <DisconnectConfirmationView confirmation={confirmation()} onConfirm={props.onConfirmDisconnect ?? (() => {})} onCancel={props.onCancelDisconnect ?? (() => {})} />}
      </Show>
    </ModalFrame>
  )
}


function ProviderList(props: { rows: AuthRow[]; cursor: number; maxHeight: number; rowWidth: number; onSelect: (index: number) => void }) {
  let scroll: ScrollBoxRenderable | undefined
  function revealSelection(): void {
    if (!scroll) return
    const cursor = props.cursor
    const children = scroll.getChildren()
    const selected = children[cursor]
    if (!selected) return
    let first = cursor
    while (first > 0 && (props.rows[first - 1]?.kind === "heading" || props.rows[first - 1]?.kind === "provider-group")) first--
    // SAFETY: Each AuthRow renders one child, and first is within the confirmed selected child's range.
    if (first < cursor) scroll.scrollChildIntoView(children[first]!.id)
    scroll.scrollChildIntoView(selected.id)
  }
  let revealTimer: ReturnType<typeof setTimeout> | undefined
  function revealAfterLayout(): void {
    clearTimeout(revealTimer)
    revealTimer = setTimeout(revealSelection, 0)
  }
  onCleanup(() => clearTimeout(revealTimer))
  createEffect(on(() => props.cursor, revealSelection))
  return (
    <scrollbox
      ref={(element: ScrollBoxRenderable) => { scroll = element }}
      maxHeight={props.maxHeight}
      scrollbarOptions={{ visible: false }}
      onSizeChange={revealAfterLayout}
    >
      <For each={props.rows}>
        {(row, index) => row.kind === "profile"
          ? <ProfileRow row={row} index={index()} cursor={props.cursor} rowWidth={props.rowWidth} onSelect={props.onSelect} />
          : row.kind === "profile-policy"
            ? <ProfilePolicyRow row={row} index={index()} rowWidth={props.rowWidth} onSelect={props.onSelect} />
          : row.kind === "file-attention"
            ? <FileAttentionRow row={row} />
          : row.kind === "heading"
            ? <HeadingRow label={row.label} first={index() === 0} />
            : row.kind === "provider-group"
              ? <ProviderGroupRow row={row} />
              : row.kind === "provider"
                ? <ProviderRow row={row} index={index()} cursor={props.cursor} rowWidth={props.rowWidth} onSelect={props.onSelect} />
                : <AccountRow row={row} index={index()} cursor={props.cursor} rowWidth={props.rowWidth} onSelect={props.onSelect} />}
      </For>
    </scrollbox>
  )
}

function ProfilePolicyRow(props: { row: Extract<AuthRow, { kind: "profile-policy" }>; index: number; rowWidth: number; onSelect: (index: number) => void }) {
  const { theme } = useTheme()
  const label = () => truncateToWidth(`  [${props.row.enabled ? "x" : " "}] Enable new models automatically for this profile${props.row.changing ? " · Saving..." : ""}`, props.rowWidth)
  return <box selectable={false} flexDirection="column" paddingLeft={2} paddingRight={1} onMouseDown={() => props.onSelect(props.index)}>
    <text fg={props.row.changing ? theme.textMuted : props.row.enabled ? theme.success : theme.text} overflow="hidden" wrapMode="none">{label()}</text>
    <Show when={props.row.feedback}>{(feedback) => <text fg={theme.error} overflow="hidden" wrapMode="none">{truncateToWidth(`    ${feedback()}`, props.rowWidth)}</text>}</Show>
  </box>
}

function FileAttentionRow(props: { row: Extract<AuthRow, { kind: "file-attention" }> }) {
  const { theme } = useTheme()
  return <box selectable={false} flexDirection="column" paddingLeft={3} paddingRight={1} paddingTop={1}>
    <text fg={theme.warning}>Authentication file needs attention</text>
    <text fg={theme.textMuted}>{props.row.attention.message}</text>
    <text fg={theme.text} selectable wrapMode="word">{props.row.attention.path}</text>
  </box>
}

function ProfileRow(props: { row: Extract<AuthRow, { kind: "profile" }>; index: number; cursor: number; rowWidth: number; onSelect: (index: number) => void }) {
  const { theme } = useTheme()
  const active = createMemo(() => props.cursor === props.index)
  const content = createMemo(() => profileRowContent(props.row, active(), theme, props.rowWidth))
  return <box selectable={false} backgroundColor={active() ? theme.backgroundElement : undefined} paddingLeft={2} paddingRight={1} onMouseDown={() => props.onSelect(props.index)}><text ref={(el: TextRenderable) => { createEffect(() => { el.content = content() }) }} overflow="hidden" wrapMode="none" /></box>
}

function HeadingRow(props: { label: string; first: boolean }) {
  const { theme } = useTheme()
  return (
    <box selectable={false} paddingLeft={2} paddingRight={1} paddingTop={props.first ? 0 : 1}>
      <text fg={theme.textMuted}>{props.label}</text>
    </box>
  )
}

function ProviderGroupRow(props: { row: Extract<AuthRow, { kind: "provider-group" }> }) {
  const { theme } = useTheme()
  return <box selectable={false} paddingLeft={4} paddingRight={1}><text fg={theme.text}>{props.row.option.label}</text></box>
}

function ProviderRow(props: { row: Extract<AuthRow, { kind: "provider" }>; index: number; cursor: number; rowWidth: number; onSelect: (index: number) => void }) {
  const { theme } = useTheme()
  const active = createMemo(() => props.cursor === props.index)
  const content = createMemo(() => providerRowContent(props.row, active(), theme, props.rowWidth))

  return (
    <box selectable={false} backgroundColor={active() ? theme.backgroundElement : undefined} paddingLeft={2} paddingRight={1} onMouseDown={() => props.onSelect(props.index)}>
      <text ref={(el: TextRenderable) => { createEffect(() => { el.content = content() }) }} overflow="hidden" wrapMode="none" />
    </box>
  )
}

function AccountRow(props: { row: Extract<AuthRow, { kind: "account" }>; index: number; cursor: number; rowWidth: number; onSelect: (index: number) => void }) {
  const { theme } = useTheme()
  const active = createMemo(() => props.cursor === props.index)
  const content = createMemo(() => {
    const accountState = authStatusPresentation(accountStatusInput(props.row.option, props.row.account))
    const capabilityStatus = props.row.capabilityAccount === undefined ? undefined : `usage ${usageStatusLabel(props.row.capabilityAccount.providerStatus)}`
    const status = props.row.saving ? "Saving..." : capabilityStatus === undefined ? accountState.text : `${accountState.text} · ${capabilityStatus}`
    const label = truncateToWidth(`  └ ${accountTitle(props.row.account)}`, Math.max(0, props.rowWidth - displayWidth(status) - 2))
    const pad = Math.max(1, props.rowWidth - displayWidth(label) - displayWidth(status) - 1)
    const statusColor = accountState.tone === "healthy" ? theme.success : accountState.tone === "warning" ? theme.warning : theme.textMuted
    return new StyledText([stFg(active() ? theme.primary : theme.textMuted)(active() ? ">" : " "), stFg(theme.text)(label), stFg(theme.text)(" ".repeat(pad)), stFg(statusColor)(status)])
  })
  return <box selectable={false} backgroundColor={active() ? theme.backgroundElement : undefined} paddingLeft={2} paddingRight={1} onMouseDown={() => props.onSelect(props.index)}><text ref={(el: TextRenderable) => { createEffect(() => { el.content = content() }) }} overflow="hidden" wrapMode="none" /></box>
}

function providerRowContent(row: Extract<AuthRow, { kind: "provider" }>, active: boolean, theme: TuiTheme, rowWidth: number): StyledText {
  const cursor = active ? ">" : " "
  const rawLabel = ` ${row.option.label}`
  const presentation = authStatusPresentation(row.option)
  const capabilityStatus = row.capabilityAccount === undefined ? undefined : `usage ${usageStatusLabel(row.capabilityAccount.providerStatus)}`
  const status = capabilityStatus === undefined ? presentation.text : `${presentation.text} · ${capabilityStatus}`
  const statusDisplay = row.saving ? "Saving..." : presentation.tone === "healthy" ? `✓ ${status}` : status
  const label = truncateToWidth(rawLabel, Math.max(0, rowWidth - displayWidth(cursor) - displayWidth(statusDisplay) - 1))
  const statusColor = presentation.tone === "healthy" ? theme.success : presentation.tone === "warning" ? theme.warning : theme.textMuted
  const pad = Math.max(1, rowWidth - displayWidth(cursor) - displayWidth(label) - displayWidth(statusDisplay))

  return new StyledText([
    stFg(active ? theme.primary : theme.textMuted)(cursor),
    stFg(theme.text)(label),
    stFg(theme.text)(" ".repeat(pad)),
    stFg(statusColor)(statusDisplay),
  ])
}

function profileRowContent(row: Extract<AuthRow, { kind: "profile" }>, active: boolean, theme: TuiTheme, rowWidth: number): StyledText {
  const cursor = active ? ">" : " "
  const environment = row.profile.source === "environment" ? " (environment)" : ""
  const label = ` Profile: ${row.profile.displayName}${environment}`
  const detail = row.saving ? "Saving..." : `${row.position}/${row.total} · ${row.scopeLabel}${row.pending ? " · pending" : ""}`
  const pad = Math.max(1, rowWidth - cursor.length - label.length - detail.length)
  return new StyledText([stFg(active ? theme.primary : theme.textMuted)(cursor), stFg(theme.text)(label), stFg(theme.textMuted)(" ".repeat(pad)), stFg(row.pending ? theme.warning : theme.textMuted)(detail)])
}

function ProviderModelsView(props: { view: Extract<AuthView, { kind: "provider-models" }>; presentation: TextEditorPresentation; width: number; maxHeight: number; onSelect: (index: number) => void; onRecheck: () => void }) {
  const { theme } = useTheme()
  const [scrollboxRef, setScrollboxRef] = createSignal<ScrollBoxRenderable>()
  const catalog = createMemo(() => props.view.rows)
  const query = createMemo(() => props.view.query)
  const rows = createMemo(() => filterProviderModelRows(catalog(), query()))
  const keys = createMemo(() => rows().map((row) => row.modelId))
  useKeyedListScroll({ scrollbox: scrollboxRef, keys, cursor: () => props.view.cursor, anchor: () => props.view.cursor, height: () => props.maxHeight })

  return (
    <box flexDirection="column">
      <box paddingLeft={2} paddingRight={1}>
        <ControlledTextField presentation={props.presentation} focused selectionForeground={theme.selectionForeground} selectionBackground={theme.selectionBackground} placeholder="Search models" width={props.width} textColor={theme.text} placeholderColor={theme.textMuted} />
      </box>
      <box height={1} />
      {props.view.loading ? <text fg={theme.textMuted}>Loading models...</text> : undefined}
      {props.view.error ? <text fg={theme.error}>{props.view.error}</text> : undefined}
      {props.view.notice ? <text fg={theme.warning}>{props.view.notice}</text> : undefined}
      <Show when={props.view.recheckAvailable === true}>
        <box marginBottom={1}><Button label={props.view.rechecking ? "Requesting recheck..." : "Recheck access"} hotkey="ctrl+r" disabled={props.view.rechecking === true} onPress={props.onRecheck} /></box>
      </Show>
      <Show when={(props.view.audit?.remaining ?? 0) > 0}>
        <text fg={theme.textMuted}>{props.view.audit?.remaining} access check{props.view.audit?.remaining === 1 ? "" : "s"} pending</text>
      </Show>
      <Show when={props.view.rows.length === 0 && (props.view.audit?.refused ?? 0) > 0}>
        <text fg={theme.textMuted}>No models are currently available for this account.</text>
        <text fg={theme.textMuted}>Recheck access to try again.</text>
      </Show>
      <Show when={providerCatalogRequiresReconnect(props.view.catalog)}>
        <text fg={theme.warning}>Preferences can be saved. Reconnect before sending requests.</text>
      </Show>
      <scrollbox ref={setScrollboxRef} maxHeight={props.maxHeight} scrollbarOptions={{ visible: false }}>
        <For each={keys()}>{(_key, index) => {
          // SAFETY: For owns an index into the keys derived from these same rows.
          const row = createMemo(() => rows()[index()]!)
          return <ProviderModelRowView row={row()} index={index()} cursor={props.view.cursor} width={props.width} onSelect={props.onSelect} />
        }}</For>
      </scrollbox>
      <box paddingTop={1}><ModalFooter rows={providerModelsCanDeselect(props.view) ? [AUTH_CONTROL_COPY.modelSelection, AUTH_CONTROL_COPY.modelSelectionNavigation] : [AUTH_CONTROL_COPY.modelSelectionNavigation]} /></box>
    </box>
  )
}

function ProviderModelRowView(props: { row: ProviderModelRow; index: number; cursor: number; width: number; onSelect: (index: number) => void }) {
  const { theme } = useTheme()
  const active = createMemo(() => props.cursor === props.index)
  const content = createMemo(() => {
    const cursor = active() ? "> " : "  "
    const marker = props.row.optInAvailable ? `${props.row.checked ? "[x]" : "[ ]"} ` : "    "
    const contentWidth = Math.max(0, props.width - displayWidth(cursor) - displayWidth(marker))
    const label = truncateToWidth(props.row.modelId, contentWidth)
    const reasonWidth = Math.max(0, contentWidth - displayWidth(label))
    const suffix = props.row.unavailableReason !== undefined ? " · Unavailable" : props.row.accessState === "pending" ? " · Access pending" : ""
    const detail = props.row.unavailableReason === undefined ? "" : ` · ${props.row.unavailableReason}`
    const detailWidth = reasonWidth - displayWidth(suffix)
    const renderedDetail = detail !== "" && detailWidth >= displayWidth(" · x...") ? truncateToWidth(detail, detailWidth) : ""
    const reason = suffix === "" || reasonWidth < displayWidth(suffix) ? "" : `${suffix}${renderedDetail}`
    return new StyledText([
      stFg(active() ? theme.primary : theme.textMuted)(cursor),
      stFg(props.row.optInAvailable ? theme.text : theme.textMuted)(`${marker}${label}`),
      ...(reason === "" ? [] : [stFg(theme.textMuted)(reason)]),
    ])
  })
  return <box selectable={false} backgroundColor={active() ? theme.backgroundElement : undefined} paddingLeft={2} paddingRight={1} onMouseDown={() => props.onSelect(props.index)}><text ref={(el: TextRenderable) => { createEffect(() => { el.content = content() }) }} overflow="hidden" wrapMode="none" /></box>
}

type SettingsCapability = NonNullable<Extract<Extract<AuthView, { kind: "provider-settings" }>["target"], { kind: "account" }>["capability"]>

/** What the catalog discovery says about the models this credential can reach, in words. */
function catalogText(catalog: ProviderCatalogDiscovery | undefined): Fact | undefined {
  if (catalog === undefined) return undefined
  const value = providerCatalogStatusText(catalog)
  return value === undefined ? undefined : { label: "Catalog", value, tone: catalog.kind === "unavailable" || catalog.liveOutcome !== "valid" ? "warning" : "muted" }
}
function connectionFact(status: { readonly source: AuthProviderSource; readonly expired: boolean; readonly attention?: AuthProviderAttention | AuthAccountAttention; readonly catalog?: ProviderCatalogDiscovery }): Fact {
  const presentation = authStatusPresentation(status)
  // Reconnect fixes only rejected or invalid credentials; storage attention names its own file and message.
  if (presentation.text === "needs attention") {
    const reconnect = status.attention === undefined && (status.source === "invalid" || providerCatalogRequiresReconnect(status.catalog))
    return { label: "Status", value: reconnect ? "Needs attention · reconnect to continue" : "Needs attention", tone: "warning" }
  }
  return presentation.text === "expired" ? { label: "Status", value: "Expired · reconnect to continue", tone: "warning" } : { label: "Status", value: "Active", tone: "success" }
}

function ProviderSettingsView(props: { view: Extract<AuthView, { kind: "provider-settings" }>; consent?: SubscriptionSpendConsentControlState; onOpenModels: () => void; onToggleFreeRoutes: () => void; onToggle: (envelopeId: string) => void }) {
  const { theme } = useTheme()
  const accountTarget = () => props.view.target.kind === "account" ? props.view.target : undefined
  const capability = () => accountTarget()?.capability
  const detail = () => { const current = capability(); return current === undefined ? undefined : subscriptionSpendConsentDetail(props.consent, current) }
  // The Models button is the one stop before the paid-use rows, so it carries focus while the consent cursor sits above them.
  const modelsFocused = () => props.view.option.modelSelectionAvailable && accountTarget() !== undefined && (detail() === undefined || detail()?.cursor === CONSENT_ACTION_CURSOR)
  const facts = (): Fact[] => {
    const target = accountTarget()
    const cap = capability()
    const rows: (Fact | undefined)[] = [
      connectionFact({ source: target?.account.source ?? props.view.option.source, expired: target?.account.expired ?? props.view.option.expired, attention: target?.account.attention ?? props.view.option.attention, catalog: target?.account.catalog ?? props.view.option.catalog }),
      ...[props.view.option.attention, target?.account.attention].map((attention) => attention === undefined ? undefined : { label: "Attention", value: attention.message, tone: "warning" as const, wrap: true }),
      props.view.attentionPath === undefined ? undefined : { label: "Authentication file", value: props.view.attentionPath, wrap: true },
    ]
    if (target === undefined) rows.push(props.view.option.keyHint === undefined ? undefined : { label: "API key", value: props.view.option.keyHint })
    else {
      rows.push(target.account.source === "stored_key" ? { label: "API key", value: target.account.identity } : { label: "Account", value: target.account.identity })
      if (target.account.label !== undefined && target.account.label !== "") rows.push({ label: "Label", value: target.account.label })
      if (target.account.enterpriseDomain !== undefined) rows.push({ label: "Enterprise", value: target.account.enterpriseDomain })
      const plan = [cap?.plan ?? target.account.plan, cap?.tier].filter((value): value is string => value !== undefined && value.length > 0).join(" · ")
      if (plan !== "") rows.push({ label: "Plan", value: plan })
      if (cap !== undefined) rows.push({ label: "Usage", value: usageStatusLabel(cap.providerStatus), tone: cap.providerStatus === "ok" ? "success" : cap.providerStatus === "unknown" ? "muted" : "warning" })
    }
    rows.push(catalogText(target?.account.catalog ?? props.view.option.catalog))
    return rows.filter((row): row is Fact => row !== undefined)
  }
  // The Models button names its own key, so the footer lists only the actions without a button.
  const footer = () => {
    const rows = accountTarget() === undefined ? [AUTH_CONTROL_COPY.providerSettingsActions] : subscriptionSpendFooterRows(detail(), capability()?.billingUrl !== undefined)
    return props.view.freeRoutes === undefined ? rows : [`f free routes · ${rows[0]}`, ...rows.slice(1)]
  }
  return <box flexDirection="column">
    <Section title="ACCOUNT" first><Facts rows={facts()} /></Section>
    <Show when={capability()}>{(cap) => <PaidUse title="PAID USE IN FLYWHEEL" capability={cap()} detail={detail()} onToggle={props.onToggle} />}</Show>
    <Show when={props.view.freeRoutes}>{(freeRoutes) => <Section title="ROUTING">
      <box onMouseDown={() => { if (!freeRoutes().changing) props.onToggleFreeRoutes() }}>
        <text fg={freeRoutes().changing ? theme.textMuted : freeRoutes().enabled ? theme.success : theme.text}>{`  [${freeRoutes().enabled ? "x" : " "}] Include and prefer free routes${freeRoutes().changing ? " · Saving..." : ""}`}</text>
      </box>
      <Show when={freeRoutes().feedback}>{(feedback) => <text fg={theme.warning}>{feedback()}</text>}</Show>
    </Section>}</Show>
    <Show when={props.view.option.modelSelectionAvailable}><box marginTop={1}><Button label="Models" hotkey="enter" focused={modelsFocused()} onPress={props.onOpenModels} /></box></Show>
    <box marginTop={1}><ModalFooter rows={footer()} align="left" /></box>
  </box>
}

/** The paid-use question (PI-MODEL-018): why it is asked, one checkbox per
 *  paid mode, and Continue. Escape answers it too, so the frame never locks. */
function PaidUseQuestionView(props: { view: Extract<AuthView, { kind: "paid-use-question" }>; consent?: SubscriptionSpendConsentControlState; onToggle: (envelopeId: string) => void; onContinue: () => void }) {
  const { theme } = useTheme()
  const detail = () => subscriptionSpendConsentDetail(props.consent, props.view.capability)
  const continueFocused = () => detail()?.cursor === CONSENT_ACTION_CURSOR
  return <box flexDirection="column">
    <box flexDirection="column" gap={1}>
      <For each={paidUseQuestionLines(props.view.option.label, props.view.account.identity, props.view.capability)}>{(line) => <text fg={theme.text} wrapMode="word">{line}</text>}</For>
    </box>
    <PaidUse title={SUBSCRIPTION_SPEND_CONSENT_COPY.questionTitle} capability={props.view.capability} detail={detail()} onToggle={props.onToggle} />
    <box marginTop={1}><Button label="Continue" hotkey="enter" focused={continueFocused()} onPress={props.onContinue} /></box>
    <box marginTop={1}><ModalFooter rows={paidUseQuestionFooterRows(props.view.capability.billingUrl !== undefined)} align="left" /></box>
  </box>
}

/** Each supported paid mode has a consent checkbox; usage evidence is information only. */
function PaidUse(props: { title: string; capability: SettingsCapability; detail: ReturnType<typeof subscriptionSpendConsentDetail>; onToggle: (envelopeId: string) => void }) {
  const { theme } = useTheme()
  const modes = () => props.detail?.consent.accounts[0]?.modes ?? props.capability.modes
  const label = (mode: SettingsCapability["modes"][number]) => mode.mode === "prepaid" ? "Prepaid" : "Automatic billing"
  const width = () => Math.max(...modes().map((mode) => label(mode).length))
  const evidence = (mode: SettingsCapability["modes"][number]) => {
    const reading = paidUseEvidence(mode.evidence)
    return [reading.status, ...reading.details].join(" · ")
  }
  return <Section title={props.title}>
    <Index each={modes()}>{(mode, index) => {
      const checked = () => mode().decision === "accepted"
      const focused = () => props.detail?.cursor === index
      const saving = () => props.detail?.savingEnvelopeIds.includes(mode().envelopeId) === true
      const onToggle = () => props.onToggle(mode().envelopeId)
      return <box backgroundColor={focused() ? theme.backgroundElement : undefined} onMouseDown={props.detail === undefined ? undefined : onToggle}>
        <text fg={props.detail === undefined || saving() ? theme.textMuted : checked() ? theme.success : theme.text}>{props.detail === undefined
          ? `  ${label(mode())}  ${checked() ? "On" : "Off"} · ${evidence(mode())}`
          : `${focused() ? ">" : " "} [${checked() ? "x" : " "}] ${label(mode()).padEnd(width())}  ${evidence(mode())}${saving() ? " · Saving..." : ""}`}</text>
      </box>
    }}</Index>
    <Show when={subscriptionSpendWarnsPrepaid(props.detail, props.capability)}><text fg={theme.warning}>{SUBSCRIPTION_SPEND_CONSENT_COPY.prepaidWarning}</text></Show>
    <Show when={props.capability.billingUrl}>{(url) => <Facts rows={[{ label: "Billing", value: url(), tone: "muted" }]} />}</Show>
    <Show when={props.detail?.feedback}>{(feedback) => <text fg={theme.warning}>{feedback()}</text>}</Show>
  </Section>
}

function usageStatusLabel(status: SettingsCapability["providerStatus"]): string {
  if (status === "ok") return "Healthy"
  if (status === "warning") return "Warning"
  if (status === "exhausted") return "Exhausted"
  return "Unknown"
}


function ApiKeyInputView(props: { presentation: TextEditorPresentation; keyPrefix: string | undefined; label: string; width: number }) {
  const { theme } = useTheme()
  const placeholder = createMemo(() => apiKeyPlaceholder(props.keyPrefix))
  const promptText = createMemo(() => `Paste the API key for ${props.label}:`)

  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.textMuted} overflow="hidden" wrapMode="none">{promptText()}</text>
      <box border={["top", "bottom", "left", "right"]} borderStyle="rounded" borderColor={theme.primary} paddingLeft={1} paddingRight={1}>
        <ControlledTextField presentation={props.presentation} focused selectionForeground={theme.selectionForeground} selectionBackground={theme.selectionBackground} placeholder={placeholder()} width={props.width} textColor={theme.text} placeholderColor={theme.textMuted} />
      </box>
      <ModalFooter rows={[AUTH_CONTROL_COPY.save]} align="left" />
    </box>
  )
}

function RenameInputView(props: { presentation: TextEditorPresentation; label: string; width: number; saving?: boolean }) {
  const { theme } = useTheme()
  return <box flexDirection="column" gap={1}>
    <text fg={theme.textMuted}>Rename {props.label}. Leave blank to clear:</text>
    <box border={["top", "bottom", "left", "right"]} borderStyle="rounded" borderColor={theme.primary} paddingLeft={1} paddingRight={1} onMouseDown={(event) => event.stopPropagation()}><ControlledTextField presentation={props.presentation} focused selectionForeground={theme.selectionForeground} selectionBackground={theme.selectionBackground} width={props.width} textColor={theme.text} /></box>
    <ModalFooter rows={[props.saving ? "Saving..." : AUTH_CONTROL_COPY.done]} align="left" />
  </box>
}

function ProfileInputView(props: { presentation: TextEditorPresentation; label: string; width: number; renaming?: boolean; error?: string; saving?: boolean }) {
  const { theme } = useTheme()
  return <box flexDirection="column" gap={1}>
    <text fg={theme.textMuted}>{props.label}. Enter a display name:</text>
    <box border={["top", "bottom", "left", "right"]} borderStyle="rounded" borderColor={theme.primary} paddingLeft={1} paddingRight={1} onMouseDown={(event) => event.stopPropagation()}><ControlledTextField presentation={props.presentation} focused selectionForeground={theme.selectionForeground} selectionBackground={theme.selectionBackground} width={props.width} textColor={theme.text} /></box>
    <Show when={props.error}>{(error) => <text fg={theme.error}>{error()}</text>}</Show>
    <ModalFooter rows={[props.saving ? "Saving..." : props.renaming ? AUTH_CONTROL_COPY.done : AUTH_CONTROL_COPY.save]} align="left" />
  </box>
}

function ProfileDeleteConfirmationView(props: { view: Extract<AuthView, { kind: "profile-delete-confirmation" }>; pending: boolean; maxHeight: number }) {
  const { theme } = useTheme()
  const [scroll, setScroll] = createSignal<ScrollBoxRenderable>()
  const candidates = () => props.view.preview?.kind === "choose" ? props.view.preview.candidates : []
  const cursor = () => candidates().findIndex((candidate) => candidate.id === props.view.successorId)
  const height = () => Math.min(candidates().length, Math.max(1, props.maxHeight - 8))
  const deleting = () => props.view.phase === "ready" && props.pending
  const disabled = () => props.view.phase === "loading" || (props.view.preview?.kind === "choose" && props.view.successorId === undefined)
  useKeyedListScroll({ scrollbox: scroll, keys: () => candidates().map((candidate) => candidate.id), cursor, anchor: cursor, height })
  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.text} wrapMode="word">Delete {props.view.label}? {props.view.preview?.kind === "automatic" ? `Sessions will move to ${props.view.preview.successor.displayName}. ` : props.view.preview?.kind === "fresh-default" ? "A fresh Default will be created. Sessions will move to it. " : ""}Credentials and profile settings will be removed.</text>
      <Show when={props.view.phase === "loading"}><text fg={theme.textMuted}>Loading deletion preview...</text></Show>
      <Show when={props.view.error}><text fg={theme.error} wrapMode="word">{props.view.error}</text></Show>
      <Show when={props.view.preview?.kind === "choose" ? props.view.preview : undefined}>{(preview) => <>
        <text fg={theme.textMuted}>Move sessions to (required, Up/Down to choose)</text>
        <scrollbox ref={setScroll} height={height()} scrollbarOptions={{ visible: false }}>
          <For each={preview().candidates}>{(candidate) => <text fg={candidate.id === props.view.successorId ? theme.primary : theme.text} wrapMode="none" overflow="hidden">{candidate.id === props.view.successorId ? "> " : "  "}{candidate.displayName}</text>}</For>
        </scrollbox>
      </>}</Show>
      <Show when={!deleting()} fallback={<text fg={theme.textMuted}>Deleting...</text>}>
        <box flexDirection="row" gap={2}>
          <text fg={disabled() ? theme.textMuted : props.view.choice === "confirm" ? theme.primary : theme.text}>{props.view.choice === "confirm" ? "> " : "  "}{props.view.phase === "preview-error" ? "Retry" : "Delete"}{disabled() ? " (disabled)" : ""}</text>
          <text fg={props.view.choice === "cancel" ? theme.primary : theme.text}>{props.view.choice === "cancel" ? "> " : "  "}Cancel</text>
        </box>
        <ModalFooter rows={[AUTH_CONTROL_COPY.confirmation]} align="left" />
      </Show>
    </box>
  )
}

function LoginQuestionView(props: { view: Extract<AuthView, { kind: "login-question" }>; onAnswer: (login: boolean) => void }) {
  const { theme } = useTheme()
  return <box flexDirection="column" gap={1}>
    <text fg={theme.text} wrapMode="word">{LOGIN_QUESTION_COPY.detail(props.view.question)}</text>
    <Show when={!props.view.submitting} fallback={<><text fg={theme.textMuted}>{LOGIN_QUESTION_COPY.starting}</text><ModalFooter rows={[LOGIN_QUESTION_COPY.cancelHint]} /></>}>
      <box flexDirection="row" gap={1}>
        <Button label={LOGIN_QUESTION_COPY.confirm} focused={props.view.choice === "login"} onPress={() => props.onAnswer(true)} />
        <Button label={LOGIN_QUESTION_COPY.decline} focused={props.view.choice === "decline"} onPress={() => props.onAnswer(false)} />
      </box>
      <ModalFooter rows={["←/→/tab choose", "enter answer", "esc end waiting runs"]} />
    </Show>
  </box>
}

/** The runtime's question before a new paid account replaces the free-plan accounts of its provider. */
function LoginConfirmationView(props: { view: Extract<AuthView, { kind: "login-confirmation" }>; onAnswer: (replace: boolean) => void }) {
  const { theme } = useTheme()
  return <box flexDirection="column" gap={1}>
    <text fg={theme.text} wrapMode="word">{props.view.message}</text>
    <Show when={!props.view.submitting} fallback={<><text fg={theme.textMuted}>{REPLACING_FREE_PLAN}</text><ModalFooter rows={["esc close"]} /></>}>
      <box flexDirection="row" gap={1}>
        <Button label="Replace" focused={props.view.choice === "replace"} onPress={() => props.onAnswer(true)} />
        <Button label="Keep free account" focused={props.view.choice === "keep"} onPress={() => props.onAnswer(false)} />
      </box>
      <ModalFooter rows={["←/→/tab choose", "enter answer", "esc keep free account"]} />
    </Show>
  </box>
}

/** The web client's Disconnect question in the terminal: the same title and the same consequence, from the shared
 *  copy, with the actions as buttons that name their keys. */
function DisconnectConfirmationView(props: { confirmation: DisconnectConfirmation; onConfirm: () => void; onCancel: () => void }) {
  const { theme } = useTheme()
  const label = () => props.confirmation.account === undefined ? props.confirmation.option.label : accountTitle(props.confirmation.account)
  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.warning} attributes={BOLD} wrapMode="word">{`Disconnect ${label()}?`}</text>
      <text fg={theme.text} wrapMode="word">{disconnectConsequence(props.confirmation.option, props.confirmation.account)}</text>
      <box flexDirection="row" gap={1}>
        <Button label="Disconnect" hotkey="y" onPress={props.onConfirm} />
        <Button label="Cancel" hotkey="esc" muted onPress={props.onCancel} />
      </box>
    </box>
  )
}

function LoginPromptView(props: { presentation: TextEditorPresentation; prompt: RuntimeAuthLoginPrompt; width: number }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.textMuted}>{`${props.prompt.message}:`}</text>
      <box border={["top", "bottom", "left", "right"]} borderStyle="rounded" borderColor={theme.primary} paddingLeft={1} paddingRight={1}>
        <ControlledTextField presentation={props.presentation} focused selectionForeground={theme.selectionForeground} selectionBackground={theme.selectionBackground} placeholder={props.prompt.placeholder ?? ""} width={props.width} textColor={theme.text} placeholderColor={theme.textMuted} />
      </box>
      <ModalFooter rows={[AUTH_CONTROL_COPY.continue]} align="left" />
    </box>
  )
}

function DeviceCodeView(props: { userCode?: string | undefined; url: string; question?: RuntimeAuthLoginQuestion | undefined }) {
  const { theme } = useTheme()

  return (
    <box flexDirection="column" gap={1}>
      <Show when={props.question}>{(question) => <text fg={theme.textMuted} wrapMode="word">{LOGIN_QUESTION_COPY.lead(question())}</text>}</Show>
      <text ref={(el: TextRenderable) => { createEffect(() => { el.content = new StyledText([stLink(props.url)(stFg(theme.primary)(props.url))]) }) }} wrapMode="char" />
      <Show when={props.userCode}>
        {(code) => <text ref={(el: TextRenderable) => { createEffect(() => { el.content = new StyledText([stFg(theme.textMuted)("Enter code: "), stBold(stFg(theme.text)(code()))]) }) }} />}
      </Show>
      <text fg={theme.textMuted}>Waiting for authorization...</text>
      <ModalFooter rows={[props.question ? `${props.userCode === undefined ? "" : "c copy code  "}${LOGIN_QUESTION_COPY.cancelHint}` : props.userCode === undefined ? AUTH_CONTROL_COPY.browser : AUTH_CONTROL_COPY.deviceCode]} align="left" />
    </box>
  )
}

/** The provider's page wraps in full, so a person can open it from any terminal width, and the field takes the code
 *  or address that the page shows. */
function BrowserAuthView(props: { view: Extract<AuthView, { kind: "browser-auth" }>; presentation: TextEditorPresentation; width: number }) {
  const { theme } = useTheme()

  return (
    <box flexDirection="column" gap={1}>
      <text ref={(el: TextRenderable) => { createEffect(() => { el.content = new StyledText([stLink(props.view.url)(stFg(theme.primary)(props.view.url))]) }) }} wrapMode="char" />
      <text fg={theme.textMuted} wrapMode="word">{`${props.view.question ? LOGIN_QUESTION_COPY.lead(props.view.question) : BROWSER_LOGIN_COPY.lead(props.view.label)} ${BROWSER_LOGIN_COPY.paste}`}</text>
      <Show when={!props.view.submitted} fallback={<text fg={theme.textMuted}>{BROWSER_LOGIN_COPY.submitted}</text>}>
        <box border={["top", "bottom", "left", "right"]} borderStyle="rounded" borderColor={theme.primary} paddingLeft={1} paddingRight={1}>
          <ControlledTextField presentation={props.presentation} focused selectionForeground={theme.selectionForeground} selectionBackground={theme.selectionBackground} placeholder={BROWSER_LOGIN_COPY.placeholder} width={props.width} textColor={theme.text} placeholderColor={theme.textMuted} />
        </box>
      </Show>
      <ModalFooter rows={[props.view.question ? LOGIN_QUESTION_COPY.finishHint : AUTH_CONTROL_COPY.browserCode]} align="left" />
    </box>
  )
}

/** The screen heads with the name of the command that opens it, then the
 *  nested view; the project-wide login question stands alone. */
const AUTH = KERNEL_COMMAND_NAMES.auth

function viewTitle(view: AuthView): string {
  switch (view.kind) {
    case "login-question": return LOGIN_QUESTION_COPY.title
    case "list": return AUTH
    case "provider-models": return `${AUTH} › ${view.providerTitle} models`
    case "provider-settings": return `${AUTH} › ${view.option.label}`
    case "paid-use-question": return `${AUTH} › ${view.option.label} › Paid use`
    case "api-key-input": return `${AUTH} › API key`
    case "login-prompt":
    case "login-confirmation": return `${AUTH} › ${view.label}`
    case "rename-input": return `${AUTH} › Rename account`
    case "profile-create-input": return `${AUTH} › Create profile`
    case "profile-rename-input": return `${AUTH} › Rename profile`
    case "profile-delete-confirmation": return `${AUTH} › Delete profile`
    case "device-code":
    case "browser-auth": return view.question ? LOGIN_QUESTION_COPY.title : `${AUTH} › ${view.label}`
  }
}

function listFooter(rows: AuthRow[], cursor: number): readonly [string, string] {
  const row = rows[cursor]
  const navigation = AUTH_CONTROL_COPY.navigation
  if (row?.kind === "profile") {
    if (row.profile.source === "environment") return [AUTH_CONTROL_COPY.environmentProfile, `a auto models  ${navigation}`]
    const canDelete = !row.pending && row.profile.availableProfiles.some((profile) => profile.id === row.profile.id)
    return [AUTH_LIST_ACTION_COPY[canDelete ? 0 : 1], navigation]
  }
  if (row?.kind === "account") {
    if (row.option.loginProgram !== undefined) return [AUTH_LIST_ACTION_COPY[row.option.modelSelectionAvailable ? 7 : 9], navigation]
    return [AUTH_LIST_ACTION_COPY[row.option.modelSelectionAvailable ? 3 : 4], navigation]
  }
  if (row?.kind !== "provider") return [AUTH_LIST_ACTION_COPY[5], navigation]
  const selected = row.option
  if (selected.attention !== undefined) {
    if (selected.kind === "subscription" && soleAccount(selected) !== undefined) return [AUTH_LIST_ACTION_COPY[selected.modelSelectionAvailable ? 8 : 9], navigation]
    if (authStatusPresentation(selected).configured) return [AUTH_LIST_ACTION_COPY[selected.modelSelectionAvailable ? 12 : 13], navigation]
    return [AUTH_LIST_ACTION_COPY[14], navigation]
  }
  if (selected.source === "misconfigured") return [AUTH_LIST_ACTION_COPY[6], navigation]
  if (selected.kind === "subscription") {
    const account = soleAccount(selected)
    if (account?.expired) return [AUTH_LIST_ACTION_COPY[selected.modelSelectionAvailable ? 8 : 9], navigation]
    if (account) return [AUTH_LIST_ACTION_COPY[selected.modelSelectionAvailable ? 8 : 9], navigation]
    return [AUTH_LIST_ACTION_COPY[selected.accounts.length > 0 && selected.modelSelectionAvailable ? 10 : 11], navigation]
  }
  if (authStatusPresentation(selected).configured) return [AUTH_LIST_ACTION_COPY[selected.modelSelectionAvailable ? 12 : 13], navigation]
  return [AUTH_LIST_ACTION_COPY[5], navigation]
}
