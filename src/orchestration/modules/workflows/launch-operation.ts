import { Result, Schema, SchemaTransformation } from "effect"
import { WorkflowLaunchAgentModelsSchema } from "../../../infra/workflow-types.js"
import type { InFlightRecord } from "../../../infra/event-store-types.js"
import { Log } from "../../../infra/log.js"
import { coalesceRepeats } from "../../../infra/repeat-coalescer.js"
import { loadQueueSnapshotFromReader } from "../../../workflows/view/view-store.js"
import { workflowRecoveryBasis } from "../../../workflows/vm/recovery.js"
import { readToolExecution } from "../../session/tool-execution-projection.js"
import { turnEndEntryId } from "../../session/conversation/turn-end-record.js"
import { workflowRunReader } from "../../module-catalog.js"
import { retirePlannedSessionContinuation } from "../../session/planned-session-continuation.js"
import { WORKFLOW_LAUNCH_OPERATION_KIND, workflowLaunchHost, type WorkflowLaunchOperation } from "../../workflow-host/launch-operation-contract.js"
import type {
  HeldRetainedOperation,
  ModuleRetainedOperationContribution,
  RetainedOperationCell,
  RetainedOperationContinuation,
} from "../../module-seams.js"

const log = Log.create({ service: "workflow-launch-operation" })

const WorkflowLaunchIntentFields = {
  workflowDefinitionId: Schema.NonEmptyString,
  summary: Schema.optionalKey(Schema.NonEmptyString),
  description: Schema.NonEmptyString,
  launchCwd: Schema.optionalKey(Schema.NonEmptyString),
}

const WorkflowLaunchIntentSchema = Schema.Struct({
  ...WorkflowLaunchIntentFields,
  // Cells written before 2026-10-14 omit agents and keep their original defaults.
  // Remove this compatibility note after 2027-04-14.
  agents: Schema.optionalKey(WorkflowLaunchAgentModelsSchema),
})

/** A cell that a parent wrote before agents had their name stores the fixed
 *  model choices under the stored key `steps`, which read as `agents`.
 *  Retired named launches settle with a refusal. Remove after 2027-04-30. */
const StoredWorkflowLaunchIntentSchema = Schema.Union([
  WorkflowLaunchIntentSchema,
  Schema.Struct({
    ...WorkflowLaunchIntentFields,
    steps: WorkflowLaunchAgentModelsSchema, // stored key
  }).pipe(Schema.decodeTo(WorkflowLaunchIntentSchema, SchemaTransformation.transform({
    decode: ({ steps, ...intent }): typeof WorkflowLaunchIntentSchema.Type => ({ ...intent, agents: steps }), // stored key
    encode: ({ agents, ...intent }) => ({ ...intent, steps: agents ?? {} }), // stored key
  }))),
])

function workflowLaunchOperationSchema<Launch extends Schema.Top>(launch: Launch) {
  return Schema.Struct({
    kind: Schema.Literal(WORKFLOW_LAUNCH_OPERATION_KIND),
    version: Schema.Literal(1),
    operationId: Schema.NonEmptyString,
    parentSessionId: Schema.NonEmptyString,
    parentConversationId: Schema.NonEmptyString,
    childSessionId: Schema.NonEmptyString,
    toolUseId: Schema.NonEmptyString,
    parentEntryId: Schema.NonEmptyString,
    acceptedAt: Schema.String.check(Schema.makeFilter((value) =>
      !Number.isNaN(Date.parse(value)) || "Expected an ISO datetime")),
    initiator: Schema.Literals(["person", "headless"]),
    // Cells that candidates wrote before 2026-10-03 carry the person's raw
    // command, so a stranded cell still decodes. Remove after 2027-04-03.
    acceptedInput: Schema.optionalKey(Schema.String),
    launch,
  })
}

const WorkflowLaunchOperationSchema = workflowLaunchOperationSchema(WorkflowLaunchIntentSchema) satisfies Schema.Codec<WorkflowLaunchOperation>
const StoredWorkflowLaunchOperationSchema = workflowLaunchOperationSchema(StoredWorkflowLaunchIntentSchema)

/** A current writer's acceptance: decoded strictly, once. */
const decodeAcceptance = Schema.decodeUnknownSync(WorkflowLaunchOperationSchema, { onExcessProperty: "error" })
const decodeStored = Schema.decodeUnknownResult(StoredWorkflowLaunchOperationSchema, { onExcessProperty: "error" })

/** Why a parent cannot use one of its stored cells: this release cannot read
 *  it, or it names another parent conversation. */
type UnusableCell = "unreadable" | "foreign"

/** One parent's unusable cells coalesce into one warning per episode. */
const unusableCells = coalesceRepeats<{ readonly reason: UnusableCell; readonly version: string }>({
  windowMs: 60_000,
  first: (sessionId, cell) => {
    log.warn("a workflow launch cell cannot be used by its parent; it is kept and not started", { sessionId, reason: cell.reason, version: cell.version })
  },
  repeated: (sessionId, repeats) => {
    log.warn("workflow launch cells stayed unusable", {
      sessionId,
      count: repeats.count,
      reasons: [...new Set(repeats.events.map((cell) => cell.reason))].join(","),
      versions: [...new Set(repeats.events.map((cell) => cell.version))].join(","),
    })
  },
})

/** Reads one cell that a parent conversation stores, at the reviewed
 *  historical boundary (ARCH-BOUNDARIES-001): the operation, or why the parent cannot
 *  use it. A cell of an unknown version or shape, or one stored under another
 *  key, is unreadable. A readable cell that names another parent or
 *  conversation is foreign: no writer stores one, so it is a defect to report.
 *  Either row stays as it is, no commit consumes it, and one coalesced
 *  warning names it. */
function readCell(row: InFlightRecord, sessionId: string, conversationId: string): WorkflowLaunchOperation | UnusableCell {
  const decoded = decodeStored(row.payload)
  const version = typeof row.payload.version === "number" ? String(row.payload.version) : "unknown"
  if (!Result.isSuccess(decoded) || decoded.success.operationId !== row.key) {
    unusableCells.observe(sessionId, { reason: "unreadable", version })
    return "unreadable"
  }
  if (decoded.success.parentSessionId !== sessionId || decoded.success.parentConversationId !== conversationId) {
    unusableCells.observe(sessionId, { reason: "foreign", version })
    return "foreign"
  }
  // A cell that a candidate build accepted before 2026-10-03 reserved a
  // random acknowledgement id, which reads as an unanswered message and
  // admits Resume. Nothing references the id before publication, so the
  // commit takes the settled id that the current writer reserves. Remove
  // after 2027-04-03.
  const settledEntryId = turnEndEntryId({ reason: "settled" }, decoded.success.operationId)
  return decoded.success.parentEntryId === settledEntryId ? decoded.success : { ...decoded.success, parentEntryId: settledEntryId }
}

/** The cell's operation when this parent conversation can use it. */
function ownOperation(row: InFlightRecord, sessionId: string, conversationId: string): WorkflowLaunchOperation | undefined {
  const cell = readCell(row, sessionId, conversationId)
  return typeof cell === "string" ? undefined : cell
}

function continuation(operation: WorkflowLaunchOperation): RetainedOperationContinuation {
  return {
    kind: WORKFLOW_LAUNCH_OPERATION_KIND,
    key: operation.operationId,
    ownerSessionId: operation.parentSessionId,
    target: { kind: "workflow", workflowId: operation.childSessionId },
    bindingId: operation.toolUseId,
  }
}

/** Retained named launches still settle after an upgrade. Remove after 2027-04-30. */
export const workflowLaunchRetainedOperation = {
  kind: WORKFLOW_LAUNCH_OPERATION_KIND,
  /** A cell this release cannot read still reports the parent's work as
   *  pending, so a person sees the parent waits and the row is never lost.
   *  A foreign cell is never this parent's work. */
  async pending(reader, sessionId, conversationId) {
    return (await reader.readInFlight(sessionId, WORKFLOW_LAUNCH_OPERATION_KIND))
      .some((row) => readCell(row, sessionId, conversationId) !== "foreign")
  },
  continuation: {
    kind: WORKFLOW_LAUNCH_OPERATION_KIND,
    async pending({ reader, manager, sessionId, conversationId }) {
      const retained = (await reader.readInFlight(sessionId, WORKFLOW_LAUNCH_OPERATION_KIND)).flatMap((row) => {
        const operation = ownOperation(row, sessionId, conversationId)
        return operation ? [continuation(operation)] : []
      })
      const parent = await manager.read(sessionId)
      if (parent?.kind !== "chat" || parent.conversationId !== conversationId) return retained
      const published = (await Promise.all((await workflowRunReader(reader).listForParent(sessionId)).map(async ({ workflowId, run }): Promise<RetainedOperationContinuation | null> => {
        if (
          !await hasRuntimeLaunchBinding(reader, sessionId, run.launchedFrom.toolUseId)
          || !await initializedWorkflow(reader, workflowId)
        ) return null
        return {
          kind: WORKFLOW_LAUNCH_OPERATION_KIND,
          key: `published:${workflowId}`,
          ownerSessionId: sessionId,
          target: { kind: "workflow", workflowId },
          bindingId: run.launchedFrom.toolUseId,
        }
      }))).filter((operation) => operation !== null)
      return [...retained, ...published]
    },
    async resolve({ reader, manager, operation }) {
      if (operation.kind !== WORKFLOW_LAUNCH_OPERATION_KIND || operation.target.kind !== "workflow") return null
      const owner = await manager.read(operation.ownerSessionId)
      if (owner?.kind === "chat") {
        const row = (await reader.readInFlight(operation.ownerSessionId, WORKFLOW_LAUNCH_OPERATION_KIND))
          .find((candidate) => candidate.key === operation.key)
        const retained = row ? ownOperation(row, operation.ownerSessionId, owner.conversationId) : undefined
        if (retained?.childSessionId === operation.target.workflowId && retained.toolUseId === operation.bindingId) {
          return { sessionId: operation.ownerSessionId, kind: "chat" as const }
        }
      }
      return await publishedTarget(reader, manager, operation)
    },
    async withdraw({ reader, writer, manager, operation }) {
      if (operation.target.kind === "workflow" && await publishedTarget(reader, manager, operation)) await retirePlannedSessionContinuation({ reader, writer, sessionId: operation.target.workflowId })
    },
  },
  bind: ({ reader, writer, hosts }) => {
    /** The commit reads its host only when it runs, so reading cells never
     *  builds the workflow controller (a chat Resume reads them every time). */
    const held = (cell: RetainedOperationCell, operation: WorkflowLaunchOperation): HeldRetainedOperation => ({
      kind: WORKFLOW_LAUNCH_OPERATION_KIND,
      key: cell.key,
      commit: async () => {
        const host = hosts.get(workflowLaunchHost)
        if (!host) throw new Error("This composition binds no workflow launch host")
        return await host.commitLaunch(operation, cell)
      },
    })
    const cellOf = (sessionId: string, conversationId: string, row: InFlightRecord): RetainedOperationCell =>
      ({ sessionId, conversationId, kind: WORKFLOW_LAUNCH_OPERATION_KIND, key: row.key, raw: row.raw })

    return {
      kind: WORKFLOW_LAUNCH_OPERATION_KIND,
      async accept({ sessionId, conversationId, operation: acceptance }) {
        if (acceptance.kind !== WORKFLOW_LAUNCH_OPERATION_KIND) {
          throw new Error(`Workflow launch authority cannot accept ${acceptance.kind}`)
        }
        const operation = decodeAcceptance(acceptance.payload)
        if (operation.operationId !== acceptance.key) {
          throw new Error(`Workflow launch key ${acceptance.key} does not match ${operation.operationId}`)
        }
        if (operation.parentSessionId !== sessionId || operation.parentConversationId !== conversationId) {
          throw new Error(`Workflow launch ${operation.operationId} targets another parent`)
        }
        if (!writer.swapInFlight) throw new Error("Workflow launch acceptance requires exact in-flight write authority")
        const inserted = await writer.swapInFlight(sessionId, WORKFLOW_LAUNCH_OPERATION_KIND, acceptance.key, null, operation)
        const row = (await reader.readInFlight(sessionId, WORKFLOW_LAUNCH_OPERATION_KIND))
          .find((candidate) => candidate.key === acceptance.key)
        // A repeated acceptance of the same operation holds the cell the
        // first one stored; any other cell under the key is another launch.
        if (!row || (!inserted && JSON.stringify(readCell(row, sessionId, conversationId)) !== JSON.stringify(operation))) {
          throw new Error(`Workflow launch ${acceptance.key} is already reserved`)
        }
        return held(cellOf(sessionId, conversationId, row), operation)
      },
      async read({ sessionId, conversationId }) {
        return (await reader.readInFlight(sessionId, WORKFLOW_LAUNCH_OPERATION_KIND)).flatMap((row) => {
          const operation = ownOperation(row, sessionId, conversationId)
          return operation ? [held(cellOf(sessionId, conversationId, row), operation)] : []
        })
      },
    }
  },
} as const satisfies ModuleRetainedOperationContribution

async function publishedTarget(
  reader: Parameters<NonNullable<ModuleRetainedOperationContribution["continuation"]>["resolve"]>[0]["reader"],
  manager: Parameters<NonNullable<ModuleRetainedOperationContribution["continuation"]>["resolve"]>[0]["manager"],
  operation: RetainedOperationContinuation,
) {
  if (operation.target.kind !== "workflow") return null
  const child = await workflowRunReader(reader).read(operation.target.workflowId)
  if (
    !child || child.launchedFrom.parentSessionId !== operation.ownerSessionId
    || child.launchedFrom.toolUseId !== operation.bindingId
    || !await hasRuntimeLaunchBinding(reader, operation.ownerSessionId, operation.bindingId)
    || !await initializedWorkflow(reader, operation.target.workflowId)
  ) return null
  return operation.target
}

async function hasRuntimeLaunchBinding(
  reader: Parameters<NonNullable<ModuleRetainedOperationContribution["continuation"]>["resolve"]>[0]["reader"],
  parentSessionId: string,
  bindingId: string,
): Promise<boolean> {
  return (await readToolExecution(reader, parentSessionId, bindingId))?.runtimeOrigin?.operation.kind === "launch"
}

async function initializedWorkflow(
  reader: Parameters<NonNullable<ModuleRetainedOperationContribution["continuation"]>["resolve"]>[0]["reader"],
  sessionId: string,
): Promise<boolean> {
  const queue = await loadQueueSnapshotFromReader(reader, sessionId)
  const { facts } = await reader.readSlice({ aggregateId: `workflow:${sessionId}` })
  const control = workflowRecoveryBasis(facts)
  return control?.status === "ready"
    && control.attempts.every((attempt) => attempt.state._tag === "pending" && attempt.conversationId === null)
    && queue?.status === "idle"
    && queue.followUpConversationId === undefined
    && queue.attempts.every((attempt) => attempt.status === "pending" && attempt.lastConversationId === undefined)
}
