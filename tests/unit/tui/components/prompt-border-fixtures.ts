import { RGBA, type CapturedFrame } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createComponent } from "solid-js/web"

import type { ModuleComposerStatus, ModuleRowAction } from "../../../../src/protocol/protocol-module.js"
import type { SpinnerStatus } from "../../../../src/tui/hooks/spinner-status-animation.js"
import flywheelTheme from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme, type TuiTheme } from "../../../../src/tui/context/theme/resolve.js"
import type { KeyHintSpec } from "../../../../src/tui/components/key-hint-row-state.js"
import type { ComposerControlAction } from "../../../../src/tui/components/composer-border-labels.js"
import type { ComposerBorderUpdate } from "../../../../src/tui/components/composer-border-layout.js"

export const primary: KeyHintSpec[] = [{ key: "esc", label: "cancel" }]
const sessionsHint: KeyHintSpec = { key: "ctrl+s", label: "sessions" }
const newHint: KeyHintSpec = { key: "ctrl+n", label: "new" }
const closeHint: KeyHintSpec = { key: "ctrl+w", label: "close" }
export const resolvedTheme = resolveTheme(flywheelTheme, "dark")

export const baseInput = {
  modelLabel: "claude-opus-4",
  update: undefined,
  composerStatus: [],
  primaryHints: primary,
  showGlobalHints: true,
  activeSessionCount: 3,
  sessionCount: 5,
  sessionsHint,
  resumeHint: undefined,
  newHint,
  closeHint,
} as const

export function sameColor(a: RGBA, b: RGBA): boolean {
  return Math.round(a.r * 255) === Math.round(b.r * 255)
    && Math.round(a.g * 255) === Math.round(b.g * 255)
    && Math.round(a.b * 255) === Math.round(b.b * 255)
}

const noAction = () => {}
const noActions = {
  update: noAction,
  changes: noAction,
  model: noAction,
  sessions: noAction,
  new: noAction,
  close: noAction,
  switch: noAction,
  background: noAction,
  resume: noAction,
} satisfies { [Action in ComposerControlAction]: () => void }

export function spanColor(frame: CapturedFrame, text: string): RGBA | undefined {
  for (const line of frame.lines) {
    const color = line.spans.find((span) => span.text.includes(text))?.fg
    if (color) return color
  }
  return undefined
}

export async function renderStatusFrame(input: {
  theme: TuiTheme
  status: SpinnerStatus | null
  idle: boolean
  maxWidth: number
}) {
  const [{ ComposerFrame }, { createPromptBorderChunks }, { TickPoolProvider }] = await Promise.all([
    import("../../../../src/tui/components/composer-frame.js"),
    import("../../../../src/tui/components/composer-border-labels.js"),
    import("../../../../src/tui/context/tick-pool-context.js"),
  ])
  const width = input.maxWidth + 4
  function StatusFrame() {
    const chunks = createPromptBorderChunks({
      theme: input.theme,
      layout: () => ({ modelLabel: undefined, update: undefined, hints: [], sessionsClickHint: null }),
      lineWidth: () => width,
      status: () => input.status,
      idle: () => input.idle,
    })
    return createComponent(ComposerFrame, {
      theme: input.theme,
      width,
      bodyHeight: 1,
      topRightChunks: chunks.topRightChunks,
      bottomLeftChunks: chunks.bottomLeftChunks,
      bottomRightChunks: chunks.bottomRightChunks,
      controls: chunks.controls,
      actions: noActions,
      get children() { return undefined },
    })
  }
  return testRender(
    () => createComponent(TickPoolProvider, {
      get children() { return createComponent(StatusFrame, {}) },
    }),
    { width, height: 3 },
  )
}

export async function renderPromptLabelsFrame(input: {
  theme: TuiTheme
  modelLabel: string
  hints: readonly KeyHintSpec[]
  update?: ComposerBorderUpdate
  composerStatus?: readonly ModuleComposerStatus[]
  changesLabel?: string
  width?: number
  onOpenChanges?: () => void
  onDismissUpdate?: () => void
  onModuleAction?: (action: ModuleRowAction) => void
  onOpenModel?: () => void
  onOpenSessions?: () => void
  onNew?: () => void
  onClose?: () => void
  onNextTab?: () => void
  onOpenBackground?: () => void
  onResume?: () => void
  onMouseDown?: () => void
  status?: SpinnerStatus | null
}) {
  const [{ ComposerFrame }, { createPromptBorderChunks }, { TickPoolProvider }] = await Promise.all([
    import("../../../../src/tui/components/composer-frame.js"),
    import("../../../../src/tui/components/composer-border-labels.js"),
    import("../../../../src/tui/context/tick-pool-context.js"),
  ])
  const width = input.width ?? 60
  function LabelsFrame() {
    const chunks = createPromptBorderChunks({
      theme: input.theme,
      layout: () => ({
        modelLabel: input.modelLabel,
        update: input.update,
        composerStatus: input.composerStatus,
        changesLabel: input.changesLabel,
        hints: input.hints,
        sessionsClickHint: input.hints.find((hint) => hint.label.includes("session")) ?? null,
      }),
      lineWidth: () => width,
      status: () => input.status ?? null,
      idle: () => false,
    })
    return createComponent(ComposerFrame, {
      theme: input.theme,
      width,
      bodyHeight: 1,
      topRightChunks: chunks.topRightChunks,
      bottomLeftChunks: chunks.bottomLeftChunks,
      bottomRightChunks: chunks.bottomRightChunks,
      controls: chunks.controls,
      actions: {
        ...noActions,
        changes: () => input.onOpenChanges?.(),
        update: () => input.onDismissUpdate?.(),
        model: () => input.onOpenModel?.(),
        sessions: () => input.onOpenSessions?.(),
        new: () => input.onNew?.(),
        close: () => input.onClose?.(),
        switch: () => input.onNextTab?.(),
        background: () => input.onOpenBackground?.(),
        resume: () => input.onResume?.(),
      },
      onModuleAction: input.onModuleAction,
      onMouseDown: () => input.onMouseDown?.(),
      get children() { return undefined },
    })
  }
  return testRender(
    () => createComponent(TickPoolProvider, {
      get children() { return createComponent(LabelsFrame, {}) },
    }),
    { width, height: 3 },
  )
}
