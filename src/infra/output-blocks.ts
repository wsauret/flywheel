import { MutationEvidenceSchema } from "./mutation-evidence-schema.js"
import { ToolResultActionSchema } from "./tool-result-action.js"
import { ToolActionSchema } from "./workflow-types.js"
import { Schema } from "effect"
import type { MessageProducer } from "./chat-input.js"
import { SessionRelationSchema } from "./chat-input-schema.js"

// Required fields reflect writer invariants:
//   - id (every kind): every block carries a stable, position-independent id - the unified
//     list/render/index/cursor key resolved by `blockIdentity(block)`. text/thinking/agentGroup keep
//     their source/agent key; tools keep their provider toolUseId when present; the builder mints one
//     at insertion for kinds with no natural id (system/divider/userMessage and provider-less tools).
//   - UserMessageBlock.pending / injected: writers always pass booleans.
//   - QuestionEntry.multiSelect: question normalization always supplies a boolean.
//   - QuestionEntry.choices: writers always append a freeform choice, so every question
//     has at least one choice and the renderer never needs an "is freeform allowed?" check.
// Optional fields are genuinely conditional or set later in the lifecycle:
//   - ToolEntry.{invocationBody,linkUri,diff,content,filetype,exitCode}: set only when the tool surfaces them.
//     Generated mutation input uses content/filetype as provisional evidence
//     through pending and failure; mutationEvidence names settled evidence.
//   - ToolEntry.targetSessionId: set only for a call whose display declares the session it addresses.
//     The transcript projection reads it and the wire edges (frontend-output-blocks.ts) drop it.
//   - ToolEntry.mutationEvidence: set only from the recorded result of a tool that publishes a durable mutation
//     (skill_manage, memory, and the file tools write/edit), which attaches the canonical artifact its write captured.
//   - ToolEntry.{invocationBodyOmittedBytes,diffOmission,contentOmittedLines}: set only by a wire edge that omits body data.
//     The derived-history edge (transcript-queries.ts) sets all three; the live edge (frontend-output-blocks.ts)
//     sets contentOmittedLines for a tool body larger than its inline limit. Both edges serve the omitted body
//     through the outputBlockBody query.
//   - AgentGroupBlock.{agentType,latestChild,duration,errorMessage,model,linkUri,totalTokens}: agentType exists only for
//     subagent-backed groups; the remaining fields are populated as children arrive / agent completes.
//   - SystemBlock.level: defaults to "info" by omission; only set on "error".
//   - SystemBlock.mutationEvidence: set only for a learning review notice, which carries
//     the skill writes the notice reports; both the live event and chat-tree re-projection set it.
//   - ThinkingBlock.completedAt: set only when status transitions to "completed".
//   - QuestionChoice (option).description: option input may be a bare string.
//   - QuestionChoice (option).recommended: model usually omits the hint.
//   - QuestionChoice (freeform).placeholder: writer may want a hint per question.
//   - QuestionEntry.header: optional chip label (≤12 chars) for the multi-question tab strip.
//   - QuestionBlock.{answers, cancelled}: set only after user interaction.

/** Preview budget shared by the TUI and derived-output wire edge. Each file in
 *  a preview-backed mutation receives this many collapsed diff lines; plain
 *  content and legacy single diffs receive one budget. */
export const TOOL_PREVIEW_LINE_LIMIT = 20

const TextBlockSchema = Schema.Struct({
  kind: Schema.Literal("text"),
  id: Schema.String,
  content: Schema.String,
  timestamp: Schema.Number,
})

/** Canonical user-facing presentation of one tool invocation, derived from the
 *  machine invocation alone by `resolveToolPresentation`. Never persisted: a
 *  reader always re-derives it, so no status or result metadata can rewrite it. */
export const ToolPresentationSchema = Schema.Struct({
  name: Schema.String,
  detail: Schema.String,
})

const ToolCallBodySchema = Schema.Struct({
  content: Schema.String,
  filetype: Schema.String,
  presentation: Schema.optionalKey(Schema.Literal("disclosure")),
})

const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const ProvisionalDiffLineSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["add", "remove", "context"]),
  text: Schema.String,
  partial: Schema.Boolean,
})

const ProvisionalDiffHunkSchema = Schema.Struct({
  id: Schema.String,
  oldStart: Schema.optionalKey(NonNegativeInteger),
  newStart: Schema.optionalKey(NonNegativeInteger),
  lines: Schema.Array(ProvisionalDiffLineSchema),
  omittedBefore: NonNegativeInteger,
  omittedAfter: NonNegativeInteger,
})

const ProvisionalDiffFileSchema = Schema.Struct({
  id: Schema.String,
  path: Schema.optionalKey(Schema.String),
  action: Schema.Literals(["add", "delete", "update"]),
  movePath: Schema.optionalKey(Schema.String),
  hunks: Schema.Array(ProvisionalDiffHunkSchema),
})

/** A derived, non-executable view of the interpretable part of streamed file-tool input. */
export const ProvisionalDiffSchema = Schema.Struct({
  files: Schema.Array(ProvisionalDiffFileSchema),
  unavailable: Schema.optionalKey(Schema.Literals(["malformed", "over-bound"])),
})

export type ProvisionalDiff = typeof ProvisionalDiffSchema.Type
export type ProvisionalDiffFile = typeof ProvisionalDiffFileSchema.Type
export type ProvisionalDiffHunk = typeof ProvisionalDiffHunkSchema.Type
export type ProvisionalDiffLine = typeof ProvisionalDiffLineSchema.Type
export type ProvisionalDiffUnavailableReason = NonNullable<ProvisionalDiff["unavailable"]>

/** Wire-only diff truncation metadata. Canonical mutation files identify their
 *  own omissions; legacy single diffs and review notices disclose as one body. */
export const DiffOmissionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("aggregate"), omittedLines: NonNegativeInteger }),
  Schema.Struct({
    kind: Schema.Literal("files"),
    files: Schema.Array(Schema.Struct({ index: NonNegativeInteger, omittedLines: NonNegativeInteger })),
  }),
])

export type DiffOmission = typeof DiffOmissionSchema.Type


const ToolEntryBaseSchema = Schema.Struct({
  kind: Schema.Literal("tool"),
  id: Schema.String,
  /** Raw machine tool identifier: registry lookup, capability behavior, and
   *  bash settlement key off this, never off the presentation name. */
  name: Schema.String,
  presentation: ToolPresentationSchema,
  /** The past-tense verb and subject used by workflow activity, not the transcript row. */
  sentence: Schema.optionalKey(ToolPresentationSchema),
  /** What the tool does, read once from its display contract where the
   *  presentation is, so a client that cannot reach the registry (the web
   *  client, over a socket or the relay) folds runs and merges reads from the
   *  same fact the terminal does. Every current producer sets it; it is
   *  optional only because a client can outlive the runtime it reads, and a
   *  row from an older runtime is then a row of its own. */
  action: Schema.optionalKey(ToolActionSchema),
  timestamp: Schema.Number,
  /** Display-only run category assigned once from the invocation's parent relationship. */
  runCategoryOverride: Schema.optionalKey(Schema.Literal("execute")),
  invocationBody: Schema.optionalKey(ToolCallBodySchema),
  linkUri: Schema.optionalKey(Schema.String),
  diff: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.String),
  filetype: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Number),
  /** Semantic outcome supplied by the tool result when the request action alone is ambiguous. */
  resultAction: Schema.optionalKey(ToolResultActionSchema),
  fileChangeKind: Schema.optionalKey(Schema.Literals(["create", "replace", "patch"])),
  /** The call's input declared that it edits project files, so it presents as
   *  a file edit while it streams and runs, before any change has landed. */
  declaresMutation: Schema.optionalKey(Schema.Literal(true)),
  /** The session the call addresses, for a call whose row names it, such as
   *  a message to another session. The row is built with the name the call's
   *  result recorded; the transcript projection replaces it with the
   *  session's current display name. The id never reaches a client. */
  targetSessionId: Schema.optionalKey(Schema.String),
  proposedDiff: Schema.optionalKey(ProvisionalDiffSchema),
  /** Bounded settlement summary. File descriptors and patch bytes stay in the manifest. */
  mutationEvidence: Schema.optionalKey(MutationEvidenceSchema),
  background: Schema.optionalKey(Schema.Boolean),
  diffOmission: Schema.optionalKey(DiffOmissionSchema),
  invocationBodyOmittedBytes: Schema.optionalKey(Schema.Number),
  contentOmittedLines: Schema.optionalKey(Schema.Number),
})

const ToolEntrySchema = Schema.Union([
  ToolEntryBaseSchema.pipe(Schema.fieldsAssign({ status: Schema.Literal("pending") })),
  ToolEntryBaseSchema.pipe(Schema.fieldsAssign({ status: Schema.Literal("streaming") })),
  ToolEntryBaseSchema.pipe(Schema.fieldsAssign({ status: Schema.Literal("completed") })),
  ToolEntryBaseSchema.pipe(Schema.fieldsAssign({ status: Schema.Literal("interrupted") })),
  ToolEntryBaseSchema.pipe(Schema.fieldsAssign({
    status: Schema.Literal("error"),
    errorMessage: Schema.String,
  })),
  // Wait-state result: a gate that returned without recording, so the model
  // must act before the step can settle, or a call whose work waits, such as
  // a held message. Not a failure; every client renders its line as a notice.
  ToolEntryBaseSchema.pipe(Schema.fieldsAssign({
    status: Schema.Literal("blocked"),
    statusMessage: Schema.String,
  })),
])

const ContainerBaseSchema = Schema.Struct({
  kind: Schema.Literal("agentGroup"),
  id: Schema.String,
  label: Schema.String,
  description: Schema.String,
  sentence: Schema.optionalKey(ToolPresentationSchema),
  children: Schema.mutable(Schema.Array(ToolEntrySchema)),
  totalToolCount: Schema.Number,
  latestChild: Schema.optionalKey(Schema.String),
  /** The child's settled active time. It never includes an open episode, so
   *  a client adds only `now - activeStartedAt` to it while the clock runs. */
  duration: Schema.optionalKey(Schema.Number),
  /** When the child's open active episode started. Only the producer that
   *  joins a running card to its child states it, and only while that
   *  child's clock runs; absent means the clock is stopped, so a client never
   *  invents a start such as the launch time. */
  activeStartedAt: Schema.optionalKey(Schema.Number),
  timestamp: Schema.Number,
  toolUseId: Schema.String,
})

const AgentFailureActionSchema = Schema.Struct({
  label: Schema.String,
  command: Schema.String,
})

export const AgentFailureDisplaySchema = Schema.Struct({
  title: Schema.String,
  message: Schema.String,
  guidance: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  action: Schema.optionalKey(AgentFailureActionSchema),
})

/** Where one agent of a workflow, or one phase of a workflow's card,
 *  stands. `parked` is the agent that an interrupt or a Stop cut, which
 *  shows the run's phase. `waiting` is an agent whose agent before it in its
 *  stream, or in its phase, has not finished, and `queued` one that waits
 *  only for a free agent. */
const WorkflowAgentStateSchema = Schema.Literals(["running", "parked", "done", "failed", "skipped", "waiting", "queued", "conditional"])
export type WorkflowAgentState = typeof WorkflowAgentStateSchema.Type

/** Words that a workflow card shows, with the tone that colours them. */
const WorkflowCardTextSchema = Schema.Struct({ text: Schema.String, tone: Schema.Literals(["plain", "done", "failed", "muted"]) })

/** One agent that a workflow card shows under its phase. An agent belongs
 *  to the one phase that lists it, so it names no phase. */
const WorkflowCardAgentSchema = Schema.Struct({
  agentNodeId: Schema.String,
  attemptId: Schema.optionalKey(Schema.String),
  /** The item key of an agent of a list, or the agent's record id. */
  label: Schema.String,
  /** The brief that the agent runs, when it is not its own. */
  briefId: Schema.optionalKey(Schema.String),
  /** The persona that the agent's record names, such as
   *  `reviewer-code-security`. */
  persona: Schema.optionalKey(Schema.String),
  state: WorkflowAgentStateSchema,
  startedAt: Schema.optionalKey(Schema.Number),
  /** The time the agent's session worked: the milliseconds before its open
   *  episode, and when that episode started, only while it runs. */
  activeMs: Schema.optionalKey(NonNegativeInteger),
  activeStartedAt: Schema.optionalKey(Schema.Number),
  /** Its handoff summary once done, why it failed or was skipped, or what
   *  it waits for. A running agent's newest call is live state, which the
   *  `workflow_live` domain carries. */
  detail: Schema.optionalKey(Schema.String),
})

/** One phase of a workflow as its card shows it: a phase of one agent, of
 *  named agents, or over a list. */
const WorkflowCardPhaseSchema = Schema.Struct({
  key: Schema.String,
  phaseId: Schema.String,
  /** The round of a phase of a repeat. */
  round: Schema.optionalKey(NonNegativeInteger),
  name: Schema.String,
  form: Schema.Literals(["single", "parallel", "list"]),
  state: WorkflowAgentStateSchema,
  /** In the units of the workflow's progress. */
  done: NonNegativeInteger,
  total: NonNegativeInteger,
  failed: NonNegativeInteger,
  /** How many agents the phase has: absent for a phase of one agent and
   *  for a phase over a list that has not read its items. */
  agentCount: Schema.optionalKey(NonNegativeInteger),
  /** Its agents by state, which its chits draw; the rest have not started.
   *  Present with `agentCount`. */
  units: Schema.optionalKey(Schema.Struct({ done: NonNegativeInteger, failed: NonNegativeInteger, running: NonNegativeInteger, parked: NonNegativeInteger })),
  /** The time the phase's run was active in the phase's span: the
   *  milliseconds before the run's open interval, and when the phase entered
   *  that interval, only while both run. */
  activeMs: Schema.optionalKey(NonNegativeInteger),
  activeStartedAt: Schema.optionalKey(Schema.Number),
  /** What the phase did, once it settled or the run did. */
  detail: Schema.optionalKey(WorkflowCardTextSchema),
  /** The ids of the agents of a phase of named agents that has not started,
   *  which its line names, each in the colour of an agent's name. */
  agentNames: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The agents the card shows under the phase, in the order it shows
   *  them; for a phase of one agent, its agent once it has an attempt. */
  agents: Schema.optionalKey(Schema.Array(WorkflowCardAgentSchema)),
  /** The agents of the phase that the card counts on one line instead. */
  agentsMore: Schema.optionalKey(Schema.Struct({
    count: NonNegativeInteger,
    done: NonNegativeInteger,
    running: NonNegativeInteger,
    parked: NonNegativeInteger,
    failed: NonNegativeInteger,
    waiting: NonNegativeInteger,
    skipped: NonNegativeInteger,
  })),
})

/** The bounded fold of a workflow's plan that its parent chat's card draws.
 *  `before` and `after` count the leading and trailing phases that the card
 *  folds into one line each. */
export const WorkflowCardSchema = Schema.Struct({
  /** Full-size folds are built locally; transcript folds are inline. */
  size: Schema.optionalKey(Schema.Literal("full")),
  /** In the units of the workflow's progress, one for each agent. */
  done: NonNegativeInteger,
  total: NonNegativeInteger,
  failed: NonNegativeInteger,
  /** The failed units that `done` counts as finished: a list's failed
   *  agents, which its join counts. */
  finishedFailed: NonNegativeInteger,
  running: NonNegativeInteger,
  /** Agents that an interrupt or a Stop cut. */
  parked: NonNegativeInteger,
  coverage: Schema.optionalKey(Schema.Array(WorkflowCardTextSchema)),
  before: NonNegativeInteger,
  after: NonNegativeInteger,
  phases: Schema.Array(WorkflowCardPhaseSchema),
})
export type WorkflowCard = typeof WorkflowCardSchema.Type

/** What an agent row stands for: one subagent run, or one workflow whose
 *  agents run on models of their own. */
export const ContainerKindSchema = Schema.Literals(["subagent", "workflow"])
export type ContainerKind = typeof ContainerKindSchema.Type

const SubagentContainerBaseSchema = ContainerBaseSchema.pipe(Schema.fieldsAssign({
  containerKind: ContainerKindSchema,
  agentType: Schema.optionalKey(Schema.String),
  totalTokens: Schema.optionalKey(Schema.Number),
  model: Schema.optionalKey(Schema.String),
  linkUri: Schema.optionalKey(Schema.String),
  /** Server-selected newest call. Child tool rows stay in the child's transcript. */
  activity: Schema.optionalKey(ToolPresentationSchema),
  /** First sentence of the completed or partial run's handoff summary. */
  summary: Schema.optionalKey(Schema.String),
  /** A workflow card's bounded fold of its plan, which its summary reader
   *  folds from the workflow's view. Absent on a subagent card, and on a
   *  workflow card whose history cannot be read. */
  card: Schema.optionalKey(WorkflowCardSchema),
}))

/** Who interrupted a run: a person from a control, the child's parent agent
 *  through its `process` tool, or the runtime at a planned shutdown. A chat's
 *  paused turn-end record and a child's card carry the same value. */
const PausedBySchema = Schema.Literals(["person", "agent", "runtime"])
export type PausedBy = typeof PausedBySchema.Type

const AgentGroupBlockSchema = Schema.Union([
  SubagentContainerBaseSchema.pipe(Schema.fieldsAssign({
    status: Schema.Union([
      Schema.Literal("pending"),
      Schema.Literal("queued"),
      Schema.Literal("active"),
      Schema.Literal("completed"),
      // The run stopped at its turn budget with a result in hand.
      Schema.Literal("partial"),
      Schema.Literal("cancelled"),
      // A person ended the run with Stop: terminal, like `cancelled`, which
      // is the requesting agent's own cancellation.
      Schema.Literal("stopped"),
      // The run ended without a result because its runner stopped: an
      // unexpected exit, or a turn boundary that swept a never-dispatched block.
      Schema.Literal("interrupted"),
    ]),
  })),
  // The run is paused from its card or by the runtime at shutdown; it resumes
  // from its recorded context and the card says who paused it.
  SubagentContainerBaseSchema.pipe(Schema.fieldsAssign({
    status: Schema.Literal("paused"),
    pausedBy: PausedBySchema,
  })),
  SubagentContainerBaseSchema.pipe(Schema.fieldsAssign({
    status: Schema.Literal("error"),
    failure: AgentFailureDisplaySchema,
  })),
])

const SystemBlockSchema = Schema.Struct({
  kind: Schema.Literal("system"),
  id: Schema.String,
  message: Schema.String,
  level: Schema.optionalKey(Schema.Union([Schema.Literal("info"), Schema.Literal("error")])),
  /** One manifest for all writes reported by this notice. */
  mutationEvidence: Schema.optionalKey(MutationEvidenceSchema),
  /** Set only by the derived-history wire edge when it truncates the notice's
   *  mutation previews (see transcript-queries.ts). */
  diffOmission: Schema.optionalKey(DiffOmissionSchema),
  timestamp: Schema.Number,
})

const ThinkingBlockSchema = Schema.Struct({
  kind: Schema.Literal("thinking"),
  id: Schema.String,
  content: Schema.String,
  status: Schema.Union([Schema.Literal("streaming"), Schema.Literal("completed")]),
  timestamp: Schema.Number,
  completedAt: Schema.optionalKey(Schema.Number),
})

const DividerBlockSchema = Schema.Struct({
  kind: Schema.Literal("divider"),
  id: Schema.String,
  label: Schema.String,
  timestamp: Schema.Number,
})

/** Saved image bytes for lazy transcript previews, in attachment order. */
export const UserMessageImageSchema = Schema.Struct({
  mediaType: Schema.String,
  data: Schema.String,
})
export type UserMessageImage = typeof UserMessageImageSchema.Type

/** The session that sent a message row: its name, its relation to the
 *  recipient, and the words of the person that the runtime attached. The row
 *  is built with the name recorded at sending, or at launch for an
 *  assignment; the transcript projection replaces it with the sender's
 *  current display name. */
export const MessageSenderSchema = Schema.Struct({
  sessionId: Schema.String,
  name: Schema.String,
  relation: SessionRelationSchema,
  /** Derived from session metadata and child-run history, never recorded in the message envelope. */
  typeLabel: Schema.optionalKey(Schema.String),
  personWords: Schema.optionalKey(Schema.String),
})
export type MessageSender = typeof MessageSenderSchema.Type

/** The sender a message row shows. The assignment that launched a subagent
 *  shows as from its parent. Of the messages from other sessions, only one
 *  that `message_session` sent carries an envelope; any other message, a
 *  steered one from before session messages included, shows as the
 *  person's. */
export function messageSenderOf(producer: MessageProducer | undefined): MessageSender | undefined {
  if (producer?.kind === "launch") return { sessionId: producer.sessionId, name: producer.name, relation: "parent" }
  if (producer?.kind !== "session" || !producer.envelope) return undefined
  const { name, relation, personWords } = producer.envelope
  return { sessionId: producer.sessionId, name, relation, ...(personWords ? { personWords } : {}) }
}

const UserMessageBlockSchema = Schema.Struct({
  kind: Schema.Literal("userMessage"),
  id: Schema.String,
  content: Schema.String,
  timestamp: Schema.Number,
  pending: Schema.Boolean,
  injected: Schema.Boolean,
  submissionIds: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  dispatchIds: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  images: Schema.optionalKey(Schema.Array(UserMessageImageSchema)),
  from: Schema.optionalKey(MessageSenderSchema),
})


const QuestionChoiceOptionSchema = Schema.Struct({
  kind: Schema.Literal("option"),
  /** Stable question-local id of this option, independent of its wording. */
  choiceId: Schema.optionalKey(Schema.String),
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
  recommended: Schema.optionalKey(Schema.Boolean),
  requiresText: Schema.optionalKey(Schema.Boolean),
})

const QuestionChoiceFreeformSchema = Schema.Struct({
  kind: Schema.Literal("freeform"),
  label: Schema.String,
  placeholder: Schema.optionalKey(Schema.String),
})

const QuestionChoiceSchema = Schema.Union([
  QuestionChoiceOptionSchema,
  QuestionChoiceFreeformSchema,
])

const QuestionEntrySchema = Schema.Struct({
  question: Schema.String,
  header: Schema.optionalKey(Schema.String),
  choices: Schema.mutable(Schema.Array(QuestionChoiceSchema)),
  multiSelect: Schema.Boolean,
})

// answers keyed by question text to match the provider wire format.
const QuestionBlockSchema = Schema.Struct({
  kind: Schema.Literal("question"),
  toolUseId: Schema.String,
  sentence: Schema.optionalKey(ToolPresentationSchema),
  questions: Schema.mutable(Schema.Array(QuestionEntrySchema)),
  answers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  cancelled: Schema.optionalKey(Schema.Boolean),
  timestamp: Schema.Number,
})

/** Safe display substitute for durable history that cannot join the selected transcript. */
export const DegradedBlockSchema = Schema.Struct({
  kind: Schema.Literal("degraded"),
  id: Schema.String,
  factFamily: Schema.Union([Schema.Literal("chat_tree"), Schema.Literal("workflow_history"), Schema.Literal("agent_input")]),
  failureClass: Schema.Union([Schema.Literal("structural_violation"), Schema.Literal("decode_failure")]),
  eventType: Schema.String,
  eventVersion: Schema.Number,
  eventPosition: Schema.Number,
  notice: Schema.Literal("Part of this transcript could not be displayed."),
  timestamp: Schema.Number,
})

export type TextBlock = typeof TextBlockSchema.Type
export type ToolPresentation = typeof ToolPresentationSchema.Type
export type ToolEntry = typeof ToolEntrySchema.Type
export type AgentFailureDisplay = typeof AgentFailureDisplaySchema.Type

/** Live tool text, keyed by `ToolEntry.id` (the provider toolUseId).
 *  Covers temporally disjoint sources: model-side input while the tool block is
 *  `status: "streaming"`, and execution output while it is `status: "pending"`.
 *  Owned by the output builder, delivered alongside blocks on each sync so
 *  per-token deltas never touch the block tree. */
export const ToolStreamingTextSchema = Schema.Union([
  Schema.Struct({
    content: Schema.String,
    filetype: Schema.optionalKey(Schema.String),
    proposedDiff: Schema.optionalKey(Schema.Never),
    previewCheck: Schema.optionalKey(Schema.Never),
  }),
  Schema.Struct({
    proposedDiff: ProvisionalDiffSchema,
    content: Schema.optionalKey(Schema.Never),
    filetype: Schema.optionalKey(Schema.Never),
    previewCheck: Schema.optionalKey(Schema.Never),
  }),
  Schema.Struct({
    previewCheck: Schema.String,
    content: Schema.optionalKey(Schema.Never),
    filetype: Schema.optionalKey(Schema.Never),
    proposedDiff: Schema.optionalKey(Schema.Never),
  }),
])

export type ToolStreamingText = typeof ToolStreamingTextSchema.Type
export type AgentGroupBlock = typeof AgentGroupBlockSchema.Type
export function isAgentInFlight(status: AgentGroupBlock["status"]): boolean {
  return status === "pending" || status === "queued" || status === "active"
}
export type SystemBlock = typeof SystemBlockSchema.Type
/** Optional metadata that lands on the SystemBlock unchanged. */
export type SystemMessageOptions = Pick<SystemBlock, "level" | "mutationEvidence"> & { readonly id?: string }
export type ThinkingBlock = typeof ThinkingBlockSchema.Type
export type DividerBlock = typeof DividerBlockSchema.Type
export type UserMessageBlock = typeof UserMessageBlockSchema.Type
export type QuestionChoice = typeof QuestionChoiceSchema.Type
export type QuestionChoiceOption = typeof QuestionChoiceOptionSchema.Type
export type QuestionEntry = typeof QuestionEntrySchema.Type
export type QuestionBlock = typeof QuestionBlockSchema.Type
export type DegradedBlock = typeof DegradedBlockSchema.Type

export const AnyBlockSchema = Schema.Union([
  TextBlockSchema,
  ToolEntrySchema,
  AgentGroupBlockSchema,
  SystemBlockSchema,
  ThinkingBlockSchema,
  DividerBlockSchema,
  UserMessageBlockSchema,
  QuestionBlockSchema,
  DegradedBlockSchema,
])

export type AnyBlock = typeof AnyBlockSchema.Type

/** True when a logical output block advances the user-visible message sequence. */
export function isVisibleMessageBlock(block: AnyBlock): boolean {
  return block.kind === "text" || (block.kind === "userMessage" && !block.pending)
}

export type StreamPhase = "waiting" | "thinking" | "generating" | "tool_executing"

// The one public answer to "what is this session's agent doing". Derived at
// the view boundary from the runner pool state and the live stream phase, so
// the store's two write channels never race on a shared field.
export type Activity = "absent" | "idle" | "awaiting_user" | "waiting" | "thinking" | "generating" | "executing_tools"

// Per-runner connection lifecycle. Independent of StreamPhase so the UI can
// show "retrying" while a turn is mid-stream, or "reconnecting" between runners.
//   - connected:    healthy stream, default
//   - retrying:     LLM client is in a retry backoff between attempts
//   - connecting:   retry backoff ended; new provider attempt is waiting for first event
//   - reconnecting: chat-session is spawning a fresh runner after a transient drop
//   - down:         truly fatal failure surfaced to the user
export type ConnectionState = "connected" | "retrying" | "connecting" | "reconnecting" | "down"
