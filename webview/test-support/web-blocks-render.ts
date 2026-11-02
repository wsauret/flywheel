import { createComponent } from "solid-js"
import { renderToString } from "solid-js/web"

import type { FrontendOutputBlock, FrontendToolEntry, FrontendToolStreamingText } from "../../src/protocol/app-service-types.js"
import type { HydratedOutputBlockBody } from "../../src/protocol/transcript-protocol-types.js"
import type { RoleAssignmentView } from "../../src/protocol/role-protocol-types.js"
import type { StatusView } from "../../src/protocol/status-protocol-types.js"
import { createBlockDisclosure } from "../src/app/block-disclosure.js"
import { Block, createToolPresentation, TurnFoldBlock } from "../src/app/blocks.js"
import { foldWebTurns } from "../src/client/turn-folds.js"
import { CompactToolRow } from "../src/app/compact-tool-row.js"
import type { RunRow } from "../../src/protocol/client/tool-run-category.js"
import { foldTranscript } from "../../src/protocol/client/transcript-model.js"
import { blockEndTimes, presentWebTranscript } from "../src/client/tool-runs.js"
import { presentedBlock } from "../src/client/presented-block-fixture.js"
import { fakeWebModuleHost } from "../src/app/client-context-fixture.js"
import { ToolGroupBlock } from "../src/app/tool-group.js"
import { LocalUserMessage } from "../src/app/message.js"
import type { LocalChatSubmission } from "../../src/protocol/client/chat-submissions.js"
import { TranscriptClock } from "../src/app/row-time.js"
import { TurnChanges } from "../src/app/turn-changes.js"
import type { MutationEvidenceReader } from "../../src/protocol/client/mutation-evidence.js"
import { WorkflowActivity } from "../src/modules/workflows/activity.js"
import { WorkflowsProvider, type WorkflowsClient } from "../src/modules/workflows/context.js"
import { ClientExtensionsProvider } from "../src/app/client-extensions.js"
import type { WebModuleClient } from "../src/web-module-client.js"

const workflows: WorkflowsClient = {
  host: fakeWebModuleHost(), choices: () => undefined, choose() {}, place: () => undefined, control() {}, open() {},
  subscribe: () => Object.assign(() => {}, { update() {} }),
}
const workflowExtension: WebModuleClient = {
  provide: render => render(), header: () => undefined, surface: () => undefined, input: () => undefined,
  coversConversation: () => false, openUri: () => false, move: () => false, back: () => false,
  block: {
    matches: block => block.kind === "agentGroup" && block.containerKind === "workflow",
    render: props => createComponent(WorkflowsProvider, {
      value: workflows,
      get children() { return createComponent(WorkflowActivity, props) },
    }),
  },
}

interface RenderBlockOptions {
  readonly inlineTime?: boolean | undefined
  readonly streaming?: FrontendToolStreamingText
  readonly body?: HydratedOutputBlockBody
  readonly reopened?: boolean
  readonly roles?: RoleAssignmentView
  /** Process membership; a test that does not name held commands holds none. */
  readonly processStatus?: Pick<StatusView, "activeBackgroundCommands" | "activeForegroundBashToolCallIds"> & Partial<Pick<StatusView, "processorHeldToolCallIds">>
  /** The status every linked child session reports. */
  readonly childStatus?: StatusView
  readonly collapsed?: boolean
  readonly canOpenFiles?: boolean
  readonly now?: number
  readonly end?: number
  readonly tailCanGrow?: boolean
  readonly mutationEvidence?: MutationEvidenceReader
}

function processStatus(options: RenderBlockOptions) {
  return options.processStatus === undefined ? undefined : { processorHeldToolCallIds: [], ...options.processStatus }
}

export function renderBlock(block: FrontendOutputBlock, options: RenderBlockOptions = {}): string {
  return renderToString(() => createComponent(TranscriptClock.Provider, {
    value: { now: () => options.now ?? Date.now(), end: () => options.end },
    get children() { return createComponent(ClientExtensionsProvider, {
      value: [workflowExtension],
      get children() { return blockComponent(block, options) },
    }) },
  }))
}

function blockComponent(block: FrontendOutputBlock, options: RenderBlockOptions = {}) {
  const disclosure = createBlockDisclosure()
  if ((block.kind === "tool" || (block.kind === "userMessage" && block.from?.relation !== "parent")) && !options.collapsed) {
    const key = `${block.kind}:${block.id}`
    disclosure.setOpen("session-1", key, true)
    if (options.reopened === true) {
      disclosure.setOpen("session-1", key, false)
      disclosure.setOpen("session-1", key, true)
    }
  }
  return createComponent(Block, {
    block: presentedBlock(block),
    inlineTime: options.inlineTime,
    sessionId: "session-1",
    disclosure,
    body: options.body,
    mutationEvidence: options.mutationEvidence,
    canOpenFiles: options.canOpenFiles ?? false,
    onOpenFile: () => {},
    onHydrate: () => {},
    onTerminateBackground: () => {},
    onDetachBash: () => {},
    working: () => false,
    onHydrateGroup: () => {},
    onSelectSession: () => {},
    roleAssignments: {
      get: () => options.roles,
      subscribe: (_sessionId, listener) => { listener(options.roles); return () => {} },
    },
    statuses: { get: () => options.childStatus, subscribe: () => () => {} },
    streaming: options.streaming,
    processStatus: processStatus(options),
    writeSyntaxTheme: "vesper",
  })
}

type RegularToolEntry = Extract<FrontendToolEntry, { readonly status: "pending" | "streaming" | "completed" | "interrupted" }>

export function tool(overrides: Partial<RegularToolEntry> = {}): FrontendToolEntry {
  return {
    kind: "tool",
    id: "write-1",
    name: "write",
    presentation: { name: "Write", detail: "src/example.ts" },
    timestamp: 0,
    status: "streaming",
    fileChangeKind: "create",
    ...overrides,
  }
}

export function renderCompactRow(row: RunRow, onOpenFile?: (path: string) => void): string {
  return renderToString(() => createComponent(CompactToolRow, { row, onOpenFile }))
}

/** Renders the stretch of calls the way the transcript would: folded into a
 *  group, with each call's own row rendered through `renderBlock`. */
export function renderGroup(children: readonly FrontendOutputBlock[], options: RenderBlockOptions = {}): string {
  const [group] = presentWebTranscript(foldTranscript(children, false)).rows
  if (group?.kind !== "toolGroup") throw new Error("expected the calls to fold into one group")
  const ends = blockEndTimes(children)
  const timedGroup = { ...group, endTimestamp: options.end ?? group.endTimestamp }
  const disclosure = createBlockDisclosure()
  if (options.reopened || (children.length === 1 && group.status !== "active" && !options.tailCanGrow && !options.collapsed)) disclosure.setOpen("session-1", group.id, true)
  const presentation: Parameters<typeof ToolGroupBlock>[0]["presentation"] = (entry, key) => createToolPresentation({
    get entry() { return entry() },
    get disclosureId() { return key() },
    sessionId: "session-1", disclosure,
    body: options.body, mutationEvidence: options.mutationEvidence,
    streaming: options.streaming, processStatus: processStatus(options),
    canOpenFiles: options.canOpenFiles ?? false, onOpenFile() {}, onSelectSession() {},
    onHydrate() {}, onTerminateBackground() {}, onDetachBash() {}, working: () => false,
    writeSyntaxTheme: "vesper",
  })
  return renderToString(() => createComponent(TranscriptClock.Provider, {
    value: { now: () => options.now ?? Date.now(), end: id => ends.get(id) ?? options.end },
    get children() { return createComponent(ToolGroupBlock, { group: timedGroup, tailCanGrow: options.tailCanGrow ?? false, sessionId: "session-1", disclosure, processStatus: processStatus(options), presentation, row: (child, inlineTime) => blockComponent(child(), { ...options, inlineTime }) }) },
  }))
}

export function renderTurnFold(blocks: readonly FrontendOutputBlock[]): string {
  const fold = foldWebTurns(presentWebTranscript(foldTranscript(blocks, true)), true).rows.find(row => row.kind === "turnFold")
  if (fold?.kind !== "turnFold") throw new Error("expected a settled turn fold")
  return renderToString(() => createComponent(TurnFoldBlock, { fold, onToggle() {} }))
}

export function renderTurnChanges(blocks: readonly FrontendOutputBlock[], openPath?: string): string {
  const fold = foldWebTurns(presentWebTranscript(foldTranscript(blocks, true)), true).rows.find(row => row.kind === "turnFold")
  if (fold?.kind !== "turnFold") throw new Error("expected a settled turn fold")
  const disclosure = createBlockDisclosure()
  if (openPath) disclosure.setOpen("session-1", `${fold.id}:changes:${openPath}`, true)
  return renderToString(() => createComponent(TurnChanges, { fold, sessionId: "session-1", disclosure, bodies: {}, onHydrate() {}, projectRoot: "/project", executionCwd: "/project" }))
}

/** Renders a message this client sent that the runtime has not shown back yet. */
export function renderLocalMessage(entry: LocalChatSubmission): string {
  return renderToString(() => createComponent(LocalUserMessage, { entry, onEdit() {}, sessionId: "session-1", disclosure: createBlockDisclosure() }))
}
