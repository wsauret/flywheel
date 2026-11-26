import { createComponent, createRoot, createSignal } from "solid-js"
import type { FrontendMutation, RuntimeHealth, RuntimeQuery } from "../../../../src/protocol/runtime/app-service-types.js"
import type { BugReportConsentResult, BugReportResult } from "../../../../src/protocol/modules/bug-reports.js"
import { ClientContext } from "../../app/client-context.js"
import { fakeClient, fakeClientHost, fakePanelSettings, fakeViewState } from "../../app/client-context-fixture.js"
import { fakeRuntimeConnection } from "../../test-support/runtime-connection-fixture.js"
import { RuntimeFaultNotice } from "../../app/toolbar/composer-status.js"
import { createElement, insert, nodes, textContent } from "../../test-support/render-ownership-host-fixture.js"
import { bugReportsWeb } from "./index.js"
import { BugReportSheet, ViewErrorReport } from "./surfaces.js"

/** Runs the real reporting surfaces with protocol outcomes and a device-owned clipboard. */
export function mountReports(options: {
  readonly kind: "crash" | "manual" | "runtime"
  readonly response?: Promise<BugReportResult>
  /** The answer to a submit after the person answered the crash screen's question. */
  readonly afterConsent?: BugReportResult
  readonly error?: Error
  readonly surface?: "web" | "phone" | "editor"
  readonly faultReport?: string
  /** The answer to the crash screen's question; the person's own answer by default. */
  readonly consent?: () => Promise<BugReportConsentResult> | BugReportConsentResult
  /** Whether the page has a project connection; a phone's machine picker has none. */
  readonly connected?: boolean
}) {
  return createRoot(dispose => {
    const root = createElement("root")
    const mutations: FrontendMutation[] = []
    const queries: RuntimeQuery[] = []
    const copied: string[] = []
    const notices: string[] = []
    const lifetime = new AbortController()
    const [health, setHealth] = createSignal<RuntimeHealth>({ kind: "crash_loop", cause: "service stopped" })
    const [sessionId, setSessionId] = createSignal("session-one")
    const [enabled, setEnabled] = createSignal(true)
    const idle = fakeViewState()
    const client = fakeClient({
      signal: lifetime.signal,
      state: () => ({ ...idle, ...(options.connected === false ? {} : { projectRoot: "/project" }), health: health(), sessionId: sessionId(), runtimeVersion: "1.2.3", runtimeBuildId: "runtime-build", settings: fakePanelSettings({ moduleIds: enabled() ? ["bug-reports"] : [] }) }),
      host: fakeClientHost({ surface: options.surface ?? "web", clientIdentity: "client-build", capabilities: { writeClipboardText: async (text) => { copied.push(text) } } }),
      connection: fakeRuntimeConnection({
        onQuery: (query) => { queries.push(query) },
        onDispatch: (mutation) => { mutations.push(mutation) },
        queries: { "bugReport.failed": () => options.faultReport ?? null },
        mutations: {
          "bugReport.submit": () => mutations.some(mutation => mutation.type === "bugReport.consent") && options.afterConsent !== undefined ? options.afterConsent : options.response ?? { ok: true, reportId: "FW-example" },
          "bugReport.consent": (mutation) => options.consent?.() ?? { ok: true, automatic: mutation.allow },
        },
      }),
      report: (_severity, text) => { notices.push(text) },
    })
    const error = options.error ?? new TypeError("stage broke")
    insert(root, createComponent(ClientContext.Provider, {
      value: client,
      get children() {
        if (options.kind === "runtime") return createComponent(RuntimeFaultNotice, { modules: [bugReportsWeb] })
        if (options.kind === "manual") return createComponent(BugReportSheet, {})
        return createComponent(ViewErrorReport, { error })
      },
    }))
    const button = (label: string) => {
      const node = nodes(root).find(item => item.tag === "button" && textContent(item) === label)
      if (!node) throw new Error(`Missing button: ${label}`)
      return node
    }
    return {
      mutations, queries, copied, notices, setHealth, setSessionId, root,
      text: () => textContent(root),
      button,
      click(label: string) {
        const run = button(label).properties.onClick
        if (typeof run !== "function") throw new Error(`Missing click: ${label}`)
        run()
      },
      type(note: string) {
        const run = nodes(root).find(item => item.tag === "textarea")?.properties.onInput
        if (typeof run !== "function") throw new Error("Missing note input")
        run({ currentTarget: { value: note } })
      },
      note: () => nodes(root).find(item => item.tag === "textarea"),
      disable() { setEnabled(false) },
      async settle() { for (let n = 0; n < 8; n++) await Promise.resolve() },
      dispose() { lifetime.abort(); dispose() },
    }
  })
}
