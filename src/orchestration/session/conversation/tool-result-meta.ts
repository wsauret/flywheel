import { createEventProjection, parseProjectionFact } from "../../../infra/event-projection.js"
import { CorruptEventRowError, type AsyncEventStateReadSurface, type StoredFact } from "../../../infra/event-store-types.js"
import { heldProjection } from "../../../infra/projection-registry.js"
import type { MutationEvidence } from "../../../infra/mutation-evidence.js"
import type { AgentFailureDisplay, ToolEntry } from "../../../infra/output-blocks.js"
import { extractDisplayMeta, resultStatusMessage, resultTargetName, type ToolResultIdentity } from "../../../infra/output/structured-event-tool-results.js"
import { hydrateToolContentFact } from "../../../infra/tool-content-hydration.js"
import type { ContentResolver } from "../../../infra/tool-content.js"
import type { ToolResultAction } from "../../../infra/tool-result-action.js"
import type { ToolOutcome } from "../../../infra/tool-outcome.js"
import { sanitizeExternalText } from "../../../infra/control-characters.js"
import { asRecord } from "../../../infra/record.js"
import { canonicalize } from "../../../infra/canonical-name.js"
import { installedRuntimeInvocationTool } from "../../module-catalog.js"
import { getToolDisplay, isHiddenFromTranscript } from "../../../infra/tools/tool-display-registry.js"
import { memoizeSuccess } from "../../../infra/success-memo.js"
import { createOrderedLane } from "../../../infra/ordered-lane.js"
import { createMicrotaskBatch } from "../../../infra/microtask-batch.js"
import { parseSessionRuntimeFact, parseStoredSessionRuntimeFact, type SessionRuntimeFact, type ToolContentReferenceFact } from "../session-runtime-event-types.js"
import { loadToolExecutionTimelineFromEvents, TOOL_EXECUTION_FACT_TYPES } from "../tool-execution-projection.js"
import type { ToolExecutionEntry } from "../tool-execution-types.js"
import { projectHistoricalContainerChild, projectHistoricalExecuteChild } from "../tool-child-presentation.js"
import type { IndexedGroupChildren } from "./branch-history-builder.js"

/** Display meta a completed tool's `tool.result.recorded` fact carried.
 *  Edit/replace diffs and filetypes live in the result `details`, not in the
 *  tool_use input the chat tree persists, so derived-history projections read
 *  this map to render the same diffs the live stream did. */
export interface ToolResultDisplayMeta {
  /** Terminal outcome from the real execution result. Deferred acknowledgements
   * in the conversation tree are not terminal evidence. */
  readonly terminalOutcome?: ToolOutcome
  /** Full user-facing result body, independent of model-context budgeting. */
  readonly displayContent?: string
  readonly diff?: string
  readonly filetype?: string
  readonly exitCode?: number
  readonly background?: boolean
  readonly executionOutput?: string
  readonly resultAction?: ToolResultAction
  readonly agentFailure?: AgentFailureDisplay
  /** Canonical artifact of the durable mutation the tool published, from its
   *  result or, for a mutating command that settled later, its settled record. */
  readonly mutationEvidence?: MutationEvidence
  /** The display name of the session the call addressed, whatever its outcome. */
  readonly targetName?: string
  /** The line of an ok result whose work now waits, such as a held message:
   *  its row settles as waiting with this line. */
  readonly statusMessage?: string
  /** When the background command the call started ended, from its settled
   *  background index record. */
  readonly endedAt?: number
}

const TOOL_RESULT_DISPLAY_META_FACT_TYPES = ["tool.result.recorded", "tool.execution_output.recorded", "tool.background_command.recorded"] as const

/** The facts a tool's display source holds: its execution facts, and the
 *  background index record of a command it left running, which states when
 *  that command ended. */
const TOOL_DISPLAY_SOURCE_FACT_TYPES = [...TOOL_EXECUTION_FACT_TYPES, "tool.background_command.recorded"] as const

export interface ToolResultDisplayMetaCatchUp {
  /** Latest tool-execution fact position read from this session, or zero. */
  readonly position: number
  readonly sources: ReadonlyMap<string, ToolDisplaySource>
  readonly childrenByParent: ReadonlyMap<string, readonly ToolDisplaySource[]>
  readonly parentPositions: ReadonlyMap<string, number>
  readonly runtimeInvocationPosition: number
  readonly runtimeInvocations: ReadonlyMap<string, RuntimeWorkflowInvocationSource>
  readMeta(source: ToolDisplaySource | undefined): Promise<ToolResultDisplayMeta | undefined>
  /** One call, its display meta, and the full result text its terminal
   *  result fact recorded, which only a nested call carries. */
  readChild(source: ToolDisplaySource): Promise<{ tool: ToolExecutionEntry; meta: ToolResultDisplayMeta | undefined; content?: string }>
  /** Captures this parent revision. Counts and identities do not resolve content;
   * selected rows share materialization with every reader using the same context. */
  children(parentToolUseId: string, context: ToolChildRenderContext): IndexedToolChildren
  /** Ordinary operations owned by this session, without parent attribution. */
  sessionChildren(context: ToolChildRenderContext): IndexedToolChildren
}

/** Rendering identity comes from the selected parent, not from a conversation lookup. */
export interface ToolChildRenderContext {
  readonly executionCwd: string
  readonly idSuffix: string
  readonly presentation: "container" | "execute"
  readonly settledCount?: number
}

interface IndexedToolChildren extends IndexedGroupChildren {
  blockId(index: number): string
}

export interface ToolDisplaySource {
  readonly toolUseId: string
  /** Canonical tool name from the call's input fact. */
  readonly toolName?: string
  /** Workspace positions of this tool's execution facts. A source keeps
   *  positions, not facts, because tool inputs and results can be megabytes
   *  and a held transcript keeps every source of its session. */
  readonly positions: readonly number[]
  readonly position: number
  readonly parentToolUseId?: string
  readonly order?: number
  readonly visible: boolean
}

interface RuntimeWorkflowInvocationSource extends ToolDisplaySource {
  readonly parentConversationId: string
  readonly parentEntryId: string
}

export interface ToolResultDisplayMetaCursorReader {
  replay(): Promise<ToolResultDisplayMetaCatchUp>
  current(): ToolResultDisplayMetaCatchUp
}

export function createToolResultDisplayMetaCursorReader(
  reader: AsyncEventStateReadSurface,
  sessionId: string,
): ToolResultDisplayMetaCursorReader {
  const owner = toolSourceOwner(reader)
  const index = owner.indexFor(sessionId)
  const sources = createToolResultDisplayMetaSetReader(reader)
  return {
    current: index.current,
    replay: async () => {
      await sources.replay([sessionId])
      return index.current()
    },
  }
}

/** The tool sources of many sessions, such as every child session a
 *  transcript's cards link. */
export interface ToolResultDisplayMetaSetReader {
  /** The sources of each named session, caught up through one position
   *  captured after the call. Replays run one at a time. */
  replay(sessionIds: Iterable<string>): Promise<ReadonlyMap<string, ToolResultDisplayMetaCatchUp>>
}

/** Catches up through one workspace-owned cursor. Different child subsets
 * share the same committed boundary and never form separate read groups.
 * The cursor starts where the owner was built, and a session's index seeds
 * from that session's own tool facts the first time a reader names it, so no
 * read or retained index covers a session that no reader asked about. */
export function createToolResultDisplayMetaSetReader(reader: AsyncEventStateReadSurface): ToolResultDisplayMetaSetReader {
  const owner = toolSourceOwner(reader)
  return { replay: (sessionIds) => owner.lane.run(async () => {
    const ids = [...new Set(sessionIds)]
    if (ids.length === 0) return new Map()
    const { changed, errors } = await owner.replay()
    for (const [id, events] of changed) if (owner.seeded.has(id)) owner.indexFor(id).fold(events)
    changed.clear()
    const unseeded = ids.filter((id) => !owner.seeded.has(id))
    if (unseeded.length > 0) {
      // One read for every session new to the owner, through the cursor's position.
      const { facts } = await reader.readSlice({
        aggregateIds: unseeded.map((id) => `session:${id}`), types: TOOL_DISPLAY_SOURCE_FACT_TYPES, beforePosition: owner.getPosition() + 1,
      }, true)
      const seeds = new Map<string, StoredFact[]>()
      for (const fact of facts) {
        if (fact instanceof CorruptEventRowError) errors.set(fact.row.aggregateId.slice("session:".length), fact)
        else {
          const seed = seeds.get(fact.aggregateId)
          if (seed) seed.push(fact)
          else seeds.set(fact.aggregateId, [fact])
        }
      }
      for (const id of unseeded) {
        owner.seeded.add(id)
        owner.indexFor(id).fold(seeds.get(`session:${id}`) ?? [])
      }
    }
    return new Map(ids.map((id) => {
      const error = errors.get(id)
      if (error) throw error
      return [id, owner.indexFor(id).current()]
    }))
  }) }
}

function toolSourceOwner(reader: AsyncEventStateReadSurface) {
  return heldProjection(reader, "tool-display-sources", () => {
    const indexes = new Map<string, ToolSourceIndex>()
    return Object.assign(createEventProjection<{ changed: Map<string, StoredFact[]>; errors: Map<string, CorruptEventRowError> }>(reader, {
      aggregatePrefix: "session:",
      factTypes: TOOL_DISPLAY_SOURCE_FACT_TYPES,
      initialState: () => ({ changed: new Map(), errors: new Map() }),
      seed: async () => ({ state: { changed: new Map(), errors: new Map() }, position: await reader.capturePosition() }),
      reduce: (state, event) => {
        const id = event.aggregateId.slice("session:".length)
        const events = state.changed.get(id) ?? []
        events.push(event)
        state.changed.set(id, events)
        return state
      },
      reduceCorruptRow: (state, error) => {
        state.errors.set(error.row.aggregateId.slice("session:".length), error)
        return state
      },
    }), {
      lane: createOrderedLane(),
      /** Sessions whose index holds every tool fact through the cursor. */
      seeded: new Set<string>(),
      indexFor(sessionId: string) {
        let index = indexes.get(sessionId)
        if (!index) {
          index = createToolSourceIndex(reader, sessionId)
          indexes.set(sessionId, index)
        }
        return index
      },
    })
  })
}

/** One session's tool sources, folded from the facts its owner reads. */
interface ToolSourceIndex {
  current(): ToolResultDisplayMetaCatchUp
  /** Folds the new tool facts selected by the workspace cursor. */
  fold(events: readonly StoredFact[]): ToolResultDisplayMetaCatchUp
}

function createToolSourceIndex(reader: AsyncEventStateReadSurface, sessionId: string): ToolSourceIndex {
  const sources = new Map<string, ToolDisplaySource>()
  const childrenByParent = new Map<string, readonly ToolDisplaySource[]>()
  const parentChildren = new Map<string, Map<string, ToolDisplaySource>>()
  const parentPositions = new Map<string, number>()
  const runtimeInvocations = new Map<string, RuntimeWorkflowInvocationSource>()
  const emptyChildren: readonly ToolDisplaySource[] = []
  const childViews = new WeakMap<readonly ToolDisplaySource[], { visible: readonly ToolDisplaySource[]; rendered: Map<string, IndexedToolChildren> }>()
  const childBodies = new WeakMap<ToolDisplaySource, Map<string, ToolEntry | Promise<ToolEntry>>>()
  let position = 0
  let runtimeInvocationPosition = 0

  const readEvents = createSourceFactReader(reader, sessionId)
  const materializers = {
    async readMeta(source: ToolDisplaySource | undefined) {
      if (!source) return undefined
      const events = await readEvents(source)
      const meta = readToolResultDisplayMetaFromEvents(events.filter(isDisplayMetaEvent), INLINE_CONTENT).get(source.toolUseId)
      const input = events.find((event) => event.type === "tool.input.completed" || event.type === "tool.runtime_invocation.recorded")
      const inputFact = input ? salvageStoredDisplayFact(input) : undefined
      const workflowInput = inputFact?.type === "tool.runtime_invocation.recorded"
        || (inputFact?.type === "tool.input.completed" && canonicalize(inputFact.payload.toolName) === installedRuntimeInvocationTool().name)
      if (!workflowInput) return meta
      const result = events.findLast((event) => event.type === "tool.result.recorded")
      const fact = result ? salvageToolResultDisplayFact(result) : undefined
      return fact?.type === "tool.result.recorded"
        ? { ...meta, terminalOutcome: fact.payload.outcome, ...canonicalDisplayContent(fact.payload.details) }
        : meta
    },
    async readChild(source: ToolDisplaySource) {
      const events = await readEvents(source)
      const tool = loadToolExecutionTimelineFromEvents(events)[0]
      if (!tool) throw new Error(`Missing tool input for ${source.toolUseId}`)
      const meta = readToolResultDisplayMetaFromEvents(events.filter(isDisplayMetaEvent), INLINE_CONTENT).get(source.toolUseId)
      const result = events.find((event) => event.id === tool.resultEventId)
      const fact = result ? salvageToolResultDisplayFact(result) : undefined
      return { tool, meta, ...(fact?.type === "tool.result.recorded" && fact.payload.content !== undefined ? { content: fact.payload.content } : {}) }
    },
  }
  function snapshot(): ToolResultDisplayMetaCatchUp {
    const capturedChildren = new Map(childrenByParent)
    const capturedSources = new Map(sources)
    let sessionChildren: readonly ToolDisplaySource[] | undefined
    const indexChildren = (children: readonly ToolDisplaySource[], context: ToolChildRenderContext): IndexedToolChildren => {
        let view = childViews.get(children)
        if (!view) {
          view = { visible: children.filter((child) => child.visible), rendered: new Map() }
          childViews.set(children, view)
        }
        const bodyKey = JSON.stringify([context.executionCwd, context.idSuffix, context.presentation])
        const viewKey = JSON.stringify([bodyKey, context.settledCount])
        const cached = view.rendered.get(viewKey)
        if (cached) return cached
        const visible = view.visible
        const sourceAt = (index: number) => {
          const source = visible[index]
          if (!source) throw new Error("Group child index is out of bounds")
          return source
        }
        const indexed: IndexedToolChildren = {
          totalCount: children.length, blockCount: visible.length,
          ...(context.settledCount !== undefined ? { settledCount: context.settledCount } : {}),
          blockId: (index) => `tool:${sourceAt(index).toolUseId}${context.idSuffix}`,
          readBlock(index) {
            const source = sourceAt(index)
            let bodies = childBodies.get(source)
            if (!bodies) {
              bodies = new Map()
              childBodies.set(source, bodies)
            }
            return memoizeSuccess(bodies, bodyKey, async () => {
              const { tool, meta, content } = await materializers.readChild(source)
              const child = context.presentation === "execute"
                ? projectHistoricalExecuteChild(tool, context.executionCwd, meta, content)
                : projectHistoricalContainerChild(tool, context.executionCwd, meta)
              return context.idSuffix ? { ...child, id: `${child.id}${context.idSuffix}` } : child
            })
          },
        }
        view.rendered.set(viewKey, indexed)
        return indexed
    }
    return {
      position,
      sources: capturedSources,
      childrenByParent: capturedChildren,
      parentPositions: new Map(parentPositions),
      runtimeInvocationPosition,
      runtimeInvocations: new Map(runtimeInvocations),
      ...materializers,
      children: (parentToolUseId, context) => indexChildren(capturedChildren.get(parentToolUseId) ?? emptyChildren, context),
      sessionChildren: (context) => {
        sessionChildren ??= [...capturedSources.values()].filter((source) => source.order !== undefined && !source.parentToolUseId)
        return indexChildren(context.settledCount === undefined ? sessionChildren : sessionChildren.slice(0, context.settledCount), context)
      },
    }
  }
  let current = snapshot()
  function fold(events: readonly StoredFact[]): ToolResultDisplayMetaCatchUp {
      if (events.length === 0) return current
      const changedParents = new Set<string>()
      for (const event of events) {
        position = event.position
        const fact = salvageStoredDisplayFact(event)
        if (!fact) continue
        const toolUseId = fact.payload.toolUseId
        const previous = sources.get(toolUseId)
        const startsRuntimeInvocation = fact.type === "tool.runtime_invocation.recorded"
        const initial = previous?.order !== undefined
          ? {}
          : startsRuntimeInvocation
            ? { order: event.timestamp, toolName: installedRuntimeInvocationTool().name, visible: true }
            : fact.type === "tool.input.completed" || fact.type === "tool.validation.failed"
              ? {
                  order: event.timestamp,
                  toolName: canonicalize(fact.payload.toolName),
                  visible: !isHiddenFromTranscript(getToolDisplay(canonicalize(fact.payload.toolName)), "input" in fact.payload ? fact.payload.input : undefined),
                  ...(fact.payload.parentToolUseId ? { parentToolUseId: fact.payload.parentToolUseId } : {}),
                }
              : {}
        const source: ToolDisplaySource = {
          toolUseId, visible: false, ...previous, positions: [...(previous?.positions ?? []), event.position], position,
          ...initial,
        }
        sources.set(toolUseId, source)
        const previousRuntime = runtimeInvocations.get(toolUseId)
        const runtimeOrigin = fact.type === "tool.runtime_invocation.recorded"
          ? {
              parentConversationId: fact.payload.parentConversationId,
              parentEntryId: fact.payload.parentEntryId,
            }
          : previousRuntime
            ? {
                parentConversationId: previousRuntime.parentConversationId,
                parentEntryId: previousRuntime.parentEntryId,
              }
            : undefined
        if (runtimeOrigin) {
          runtimeInvocationPosition = position
          runtimeInvocations.set(toolUseId, { ...source, ...runtimeOrigin })
        }
        if (source.parentToolUseId) {
          let children = parentChildren.get(source.parentToolUseId)
          if (!children) {
            children = new Map()
            parentChildren.set(source.parentToolUseId, children)
          }
          children.set(toolUseId, source)
          changedParents.add(source.parentToolUseId)
          parentPositions.set(source.parentToolUseId, position)
        }
      }
      for (const parent of changedParents) {
        // Stable sort preserves first parent-registration order for equal timestamps.
        // SAFETY: A parent enters changedParents only after its child map is created.
        childrenByParent.set(parent, [...parentChildren.get(parent)!.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)))
      }
      current = snapshot()
      return current
  }
  return { current: () => current, fold }
}

const INLINE_CONTENT: ContentResolver = { resolve: () => null }

/** The state Worker's row bound for one page. */
const SOURCE_READ_POSITIONS = 256

/** Reads the hydrated facts of tool sources. Every source requested in one
 *  synchronous pass shares one batch, so a transcript page that asks for its
 *  rows together costs one paged read for each 256 positions, not one state
 *  round trip for each row. */
function createSourceFactReader(reader: AsyncEventStateReadSurface, sessionId: string): (source: ToolDisplaySource) => Promise<StoredFact[]> {
  const aggregateId = `session:${sessionId}`

  // A page bounds rows and bytes, so one batch of large tool facts never
  // exceeds the response budget of a single exact read.
  async function readPositions(positions: readonly number[], upperPosition: number): Promise<StoredFact[]> {
    const facts: StoredFact[] = []
    let afterPosition = 0
    while (true) {
      const page = await reader.readPage({ aggregateId, positions }, upperPosition, afterPosition, false, "eager")
      for (const fact of page.facts) {
        if (!(fact instanceof Error)) facts.push(hydrateToolContentFact(fact, page.toolContent))
      }
      if (page.continuationPosition === null) return facts
      afterPosition = page.continuationPosition
    }
  }

  return createMicrotaskBatch(async (sources: readonly ToolDisplaySource[]) => {
    const positions = [...new Set(sources.flatMap((source) => source.positions))].sort((a, b) => a - b)
    const byPosition = new Map<number, StoredFact>()
    await Promise.all(Array.from({ length: Math.ceil(positions.length / SOURCE_READ_POSITIONS) }, async (_, page) => {
      const chunk = positions.slice(page * SOURCE_READ_POSITIONS, (page + 1) * SOURCE_READ_POSITIONS)
      // SAFETY: Math.ceil makes every chunk non-empty.
      for (const fact of await readPositions(chunk, chunk.at(-1)!)) byPosition.set(fact.position, fact)
    }))
    return new Map(sources.map((source) => [source, source.positions.flatMap((at) => byPosition.get(at) ?? [])]))
  })
}

type ToolDisplayFact = Extract<SessionRuntimeFact | ToolContentReferenceFact, { type: (typeof TOOL_DISPLAY_SOURCE_FACT_TYPES)[number] }>

function salvageStoredDisplayFact(event: StoredFact): ToolDisplayFact | undefined {
  try {
    return parseProjectionFact(event, (value) => parseStoredSessionRuntimeFact<ToolDisplayFact>(value))
  } catch {
    return undefined
  }
}

const DISPLAY_META_FACT_TYPE_SET: ReadonlySet<string> = new Set(TOOL_RESULT_DISPLAY_META_FACT_TYPES)

function isDisplayMetaEvent(event: StoredFact): boolean {
  return DISPLAY_META_FACT_TYPE_SET.has(event.type)
}

function readToolResultDisplayMetaFromEvents(events: readonly StoredFact[], toolContent: ContentResolver): Map<string, ToolResultDisplayMeta> {
  const meta = new Map<string, ToolResultDisplayMeta>()
  applyToolResultMetaEvents(events, toolContent, meta)
  return meta
}

export async function readToolResultDisplayMeta(reader: AsyncEventStateReadSurface, sessionId: string): Promise<Map<string, ToolResultDisplayMeta>> {
  const slice = await reader.readSlice({ aggregateId: `session:${sessionId}`, types: TOOL_RESULT_DISPLAY_META_FACT_TYPES })
  return readToolResultDisplayMetaFromEvents(
    slice.facts.filter((fact): fact is StoredFact => !(fact instanceof Error)),
    slice.toolContent,
  )
}

function applyToolResultMetaEvents(
  events: readonly StoredFact[],
  toolContent: ContentResolver,
  toolResultMeta: Map<string, ToolResultDisplayMeta>,
): void {
  for (const stored of events) {
    // Hydrate outside the salvage try/catch: a reference that cannot resolve
    // is a substrate invariant and must throw, never degrade to a skip.
    const event = hydrateToolContentFact(stored, toolContent)
    const fact = salvageToolResultDisplayFact(event)
    if (!fact) continue
    if (fact.type === "tool.execution_output.recorded") {
      const previous = toolResultMeta.get(fact.payload.toolUseId)
      toolResultMeta.set(fact.payload.toolUseId, {
        ...previous,
        executionOutput: fact.payload.output,
        ...(fact.version === 3 && fact.payload.mutationEvidence !== undefined ? { mutationEvidence: fact.payload.mutationEvidence } : {}),
      })
      continue
    }
    if (fact.type === "tool.background_command.recorded") {
      if (fact.payload.state === "settled") toolResultMeta.set(fact.payload.toolUseId, { ...toolResultMeta.get(fact.payload.toolUseId), endedAt: fact.payload.settledAtMs })
      continue
    }
    if (fact.type !== "tool.result.recorded") continue
    const previous = toolResultMeta.get(fact.payload.toolUseId)
    const identity = { source: fact.type, toolUseId: fact.payload.toolUseId }
    const targetName = resultTargetName(fact.payload.details)
    const statusMessage = resultStatusMessage(fact.payload.details)
    const generic: ToolResultDisplayMeta = {
      ...(fact.payload.outcome === "ok"
        ? {
            ...extractDisplayMeta(fact.payload.details, identity),
            ...canonicalDisplayContent(fact.payload.details),
            ...(statusMessage !== undefined ? { statusMessage } : {}),
          }
        : failedResultEvidence(fact.payload.details, identity)),
      ...(targetName !== undefined ? { targetName } : {}),
    }
    if (Object.keys(generic).length === 0) continue
    toolResultMeta.set(fact.payload.toolUseId, { ...previous, ...generic })
  }
}

/** What a failed result still proves: an agent's failure display, and the
 *  edits a shell command landed before it failed, since a timed-out `mutates`
 *  command still publishes its changes. A failed direct edit published
 *  nothing, so its details carry no mutation, conflict markers, or refused changes. */
function failedResultEvidence(details: unknown, identity: ToolResultIdentity): ToolResultDisplayMeta {
  const { agentFailure, mutationEvidence } = extractDisplayMeta(details, identity)
  return {
    ...(agentFailure !== undefined ? { agentFailure } : {}),
    ...(mutationEvidence !== undefined ? { mutationEvidence } : {}),
  }
}

function canonicalDisplayContent(details: unknown): Pick<ToolResultDisplayMeta, "displayContent"> {
  const displayContent = asRecord(details)?.displayContent
  const structured = asRecord(displayContent)
  const raw = typeof displayContent === "string"
    ? displayContent
    : typeof structured?.text === "string"
      ? structured.text
      : undefined
  if (typeof raw !== "string" || raw.trim().length === 0) return {}
  return { displayContent: sanitizeExternalText(raw) }
}

function salvageToolResultDisplayFact(event: StoredFact): ReturnType<typeof parseSessionRuntimeFact> | undefined {
  try {
    return parseProjectionFact(event, parseSessionRuntimeFact)
  } catch {
    return undefined
  }
}
