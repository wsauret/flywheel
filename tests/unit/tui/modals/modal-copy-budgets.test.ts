import { usageFooterRows } from "../../../../src/tui/modules/subscription-usage/footer.js"
import { describe, expect, it } from "bun:test"
import stringWidth from "string-width"
import { SETTING_ROWS, SETTING_SECTIONS } from "../../../../src/protocol/setting-catalog.js"
import { DEFAULT_ROLES } from "../../../../src/orchestration/config/roles.js"
import { SHIPPED_MODULES } from "../../../../src/orchestration/modules.js"
import { MODULE_SETTING_GROUPS } from "../../../../src/protocol/module-protocol-types.js"
import { DEVELOPMENT_MODULES } from "../../../../src/orchestration/development-modules.js"
import {
  AUTH_CONTROL_COPY,
  AUTH_LIST_ACTION_COPY,
  MODAL_CONTROL_COPY,
  MODAL_FRAME_WIDTHS,
  SESSION_CONTROL_COPY,
  modalCopyLimit,
  settingsGroupDescription,
  SUBSCRIPTION_SPEND_CONSENT_COPY,
} from "../../../../src/tui/components/modal-copy.js"
import { modalHelpRows } from "../../../../src/tui/modals/model-modal-chrome.js"
import type { ModelModalState, ModelModalView } from "../../../../src/tui/modals/model-modal-types.js"
import { scopeContextLine } from "../../../../src/tui/hooks/use-model-modal-scope.js"

type ModalName = keyof typeof MODAL_FRAME_WIDTHS
type AuthoredCopy = readonly [modal: ModalName, text: string, frameWidth?: number]

function modelState(view: ModelModalView, overrides: Partial<ModelModalState> = {}): ModelModalState {
  return {
    view,
    scope: "session",
    scopeToggleAvailable: true,
    assignmentItems: [],
    modelOptions: [],
    query: "",
    pendingEfforts: new Map(),
    cursor: 0,
    loading: false,
    confirmReset: false,
    ...overrides,
  }
}

const standardControls: AuthoredCopy[] = [
  ...MODAL_CONTROL_COPY.background.map((text) => ["background", text] as const),
  ...MODAL_CONTROL_COPY.commands.map((text) => ["commands", text] as const),
  ...MODAL_CONTROL_COPY.help.map((text) => ["help", text] as const),
  ...MODAL_CONTROL_COPY.profile.map((text) => ["profile", text] as const),
  ...Object.values(MODAL_CONTROL_COPY.settings).map((text) => ["settings", text] as const),
  ...MODAL_CONTROL_COPY.status.map((text) => ["status", text] as const),
  ...MODAL_CONTROL_COPY.theme.map((text) => ["theme", text] as const),
  ...Object.values(AUTH_CONTROL_COPY).map((text) => ["auth", text] as const),
  ...AUTH_LIST_ACTION_COPY.map((text) => ["auth", text] as const),
  ...SESSION_CONTROL_COPY.map((text) => ["session", text] as const),
]

const settingDescriptions: AuthoredCopy[] = [
  ...SETTING_ROWS.map((row) => ["settings", row.description] as const),
  ...SETTING_SECTIONS.flatMap((section) => section.entries.flatMap((entry) => entry.kind === "subsection" ? [["settings", entry.description] as const] : [])),
  ...MODULE_SETTING_GROUPS.map((group) => ["settings", settingsGroupDescription(group)] as const),
]

const moduleDescriptions: AuthoredCopy[] = [...SHIPPED_MODULES, ...DEVELOPMENT_MODULES].flatMap((module) => module.contributions.flatMap((contribution) =>
  contribution.domain === "settings" ? [["settings", contribution.value.description] as const] : [],
))

const modelDescriptions: AuthoredCopy[] = [
  ...Object.values(DEFAULT_ROLES).map((role) => ["model", role.description] as const),
  ["model", scopeContextLine("defaults", true)],
  ["model", scopeContextLine("defaults", false)],
]

const modelHelpRows: AuthoredCopy[] = [52, MODAL_FRAME_WIDTHS.model].flatMap((width) => [
  modelState({ kind: "assignments" }),
  modelState({ kind: "assignments" }, { confirmReset: true, scope: "defaults" }),
  modelState({ kind: "models" }),
].flatMap((state) => modalHelpRows(state, width).map((text) => ["model", text, width] as const)))

const usageRows: AuthoredCopy[] = (["accounts", "history", "spend"] as const).flatMap((view) =>
  usageFooterRows({ view }).map((text) => ["usage", text] as const))

const subscriptionSpendConsentCopy = [
  SUBSCRIPTION_SPEND_CONSENT_COPY.prepaidWarning,
  ...Object.values(SUBSCRIPTION_SPEND_CONSENT_COPY.mutationFeedback),
].map((text) => ["auth", text] as const)

describe("modal authored copy budgets", () => {
  it("keeps every production-authored description and control row within its modal content width", () => {
    const offenders = [...standardControls, ...settingDescriptions, ...moduleDescriptions, ...modelDescriptions, ...modelHelpRows, ...usageRows, ...subscriptionSpendConsentCopy].flatMap(([modal, text, frameWidth]) => {
      const limit = modalCopyLimit(frameWidth ?? MODAL_FRAME_WIDTHS[modal])
      const width = stringWidth(text)
      return width > limit ? [`${modal}: ${width}/${limit} cells: ${JSON.stringify(text)}`] : []
    })
    expect(offenders).toEqual([])
  })

  it("names the back arrow with one glyph in every control row", () => {
    const asciiBack = [...standardControls, ...modelHelpRows].filter(([, text]) => text.includes("<- back"))
    expect(asciiBack).toEqual([])
    expect(modelHelpRows.some(([, text]) => text.includes("← back"))).toBe(true)
  })

  it("always builds exactly two usage footer rows", () => {
    expect(usageFooterRows({ view: "accounts" })).toHaveLength(2)
    expect(usageFooterRows({ view: "history" })).toHaveLength(2)
  })

  it("advertises range controls only for Spend and History", () => {
    expect(usageFooterRows({ view: "accounts" }).join(" ")).not.toContain("range")
    expect(usageFooterRows({ view: "spend" }).join(" ")).toContain("←→ range")
    expect(usageFooterRows({ view: "history" }).join(" ")).toContain("←→ range")
  })
})

