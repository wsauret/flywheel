import { ReferenceReviewNoticeFields, ReviewNoticeMutationSchema } from "../../../infra/review-notice.js";
import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect";
import { LlmToolOutputPartSchema } from "../../../infra/llm/tool-output-part-schema.js";
import { ToolContentReferencePartSchema } from "../../../infra/tool-content.js";
import { AccessProviderIdSchema } from "../../../infra/llm/access-provider.js";
import { ContentRepairSchema } from "../../../infra/llm/content-repair.js";
import { SessionRelationSchema } from "../../../infra/chat-input-schema.js";
import { LLM_APIS, LLM_STOP_REASONS, MODEL_FAMILIES } from "../../agent-runtime/llm/messages.js";

const DateTimeStringSchema = Schema.String.check(
  Schema.makeFilter((value) => !Number.isNaN(Date.parse(value)) || "Expected ISO datetime string"),
);

const baseEntryFields = {
  id: Schema.NonEmptyString,
  parentId: Schema.NullOr(Schema.NonEmptyString),
  timestamp: DateTimeStringSchema,
};

const TextContentSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  signature: Schema.optionalKey(Schema.String),
});

const ImageContentSchema = Schema.Struct({
  type: Schema.Literal("image"),
  mediaType: Schema.String,
  data: Schema.String,
});

const ToolUseContentSchema = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Record(Schema.String, Schema.Unknown),
  registrationId: Schema.optionalKey(Schema.String),
  providerItemId: Schema.optionalKey(Schema.String),
  providerCallId: Schema.optionalKey(Schema.String),
  thoughtSignature: Schema.optionalKey(Schema.String),
});

const ThinkingContentSchema = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  presentation: Schema.optionalKey(Schema.Literal("progress")),
  signature: Schema.optionalKey(Schema.String),
  redacted: Schema.optionalKey(Schema.Boolean),
});

const reasoningContentFields = {
  type: Schema.Literal("reasoning"),
  id: Schema.String,
  encrypted_content: Schema.String,
  summary: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.Struct({ type: Schema.Literal("summary_text"), text: Schema.String })))),
};

/** Builds before 2026-10-06 also stored `rawItem`, the verbatim provider
 *  reasoning item, and replayed it. Replay now builds the item from the
 *  fields above, so decode drops `rawItem` and encode never writes it.
 *  Remove the `rawItem` key after 2027-04-06, when no store holds it. */
const ReasoningContentSchema = Schema.Struct({
  ...reasoningContentFields,
  rawItem: Schema.optionalKey(Schema.String),
}).pipe(Schema.decodeTo(
  Schema.Struct(reasoningContentFields),
  SchemaTransformation.transform({
    decode: ({ rawItem: _rawItem, ...block }) => block,
    encode: (block) => block,
  }),
));

// Mirrors the in-memory ContentBlock union verbatim so a rebuilt context
// replays exactly what the live loop held: thinking signatures and encrypted
// reasoning items survive a restart the same way tool calls do.
const PersistedContentBlockSchema = Schema.Union([
  TextContentSchema,
  ImageContentSchema,
  ToolUseContentSchema,
  ThinkingContentSchema,
  ReasoningContentSchema,
]);

const PersistedContentSchema = Schema.Union([Schema.String, Schema.mutable(Schema.Array(PersistedContentBlockSchema))]);

const assistantAgentMessageFields = {
  kind: Schema.Literal("assistant"),
  content: PersistedContentSchema,
  incomplete: Schema.optionalKey(Schema.Literal(true)),
  /** Serving attribution captured from the provider's done event. The
   *  same-provider replay gates read these four fields; absent means
   *  cross-provider, so opaque deliberation blocks are downgraded rather
   *  than replayed verbatim. */
  accessProvider: Schema.optionalKey(AccessProviderIdSchema),
  provider: Schema.optionalKey(Schema.Literals(MODEL_FAMILIES)),
  api: Schema.optionalKey(Schema.Literals(LLM_APIS)),
  model: Schema.optionalKey(Schema.String),
  timestamp: Schema.optionalKey(Schema.Number),
  stopReason: Schema.optionalKey(Schema.Literals(LLM_STOP_REASONS)),
  responseId: Schema.optionalKey(Schema.String),
};

/** The assistant message that `chat.entries.appended` stores. It never holds
 *  the reported reasoning count: a `chat.reasoning.reported` fact beside it
 *  holds that count, so every build reads every entries fact in full. */
const StoredAssistantAgentMessageSchema = Schema.Struct(assistantAgentMessageFields);

/** The assistant message as the fold hands it on. It also holds the
 *  reasoning tokens the provider reported for the response, folded in from
 *  `chat.reasoning.reported`, so a rebuilt context counts the thinking that
 *  the same model re-sends (see `estimateConversationTokens`). */
const AssistantAgentMessageSchema = Schema.Struct({
  ...assistantAgentMessageFields,
  reasoningTokens: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
});

const HumanProducerSchema = Schema.Struct({ kind: Schema.Literal("human") });

const sessionProducerFields = {
  kind: Schema.Literal("session"),
  sessionId: Schema.NonEmptyString,
  conversationId: Schema.NonEmptyString,
  toolUseId: Schema.NonEmptyString,
  hop: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
};

const SessionMessageEnvelopeSchema = Schema.Struct({
  name: Schema.String,
  relation: SessionRelationSchema,
  waits: Schema.Boolean,
  personWords: Schema.optionalKey(Schema.NonEmptyString),
});

/** A message from another session. A message that `message_session` sent
 *  carries its envelope; a message held before the message tool, or recovered
 *  from such a hold, carries none and reads as plain text. */
const SessionProducerSchema = Schema.Struct({
  ...sessionProducerFields,
  envelope: Schema.optionalKey(SessionMessageEnvelopeSchema),
});

/** The parent whose launching tool call gave a subagent its assignment. */
const LaunchProducerSchema = Schema.Struct({
  kind: Schema.Literal("launch"),
  sessionId: Schema.NonEmptyString,
  toolUseId: Schema.NonEmptyString,
  name: Schema.String,
});

const CurrentProducerSchema = Schema.Union([HumanProducerSchema, SessionProducerSchema, LaunchProducerSchema]);

/** The producer vocabulary of `chat.entries.appended` version 5, which has
 *  no launch producer. A build before the launch producer wrote a subagent's
 *  assignment with no producer, which still reads as the person's words. A
 *  current writer still uses version 5 for a batch with a session producer
 *  and no launch producer, so an earlier build reads it. */
const ProducerV5VocabularySchema = Schema.Union([HumanProducerSchema, SessionProducerSchema]);

/** Every version 5 producer is a current one, so it decodes unchanged. No
 *  writer encodes into an earlier version, and a launch producer has no
 *  version 5 shape, so its encoding is refused. */
const producerV5ToCurrent = SchemaTransformation.transformEffect<typeof CurrentProducerSchema.Type, typeof ProducerV5VocabularySchema.Type>({
  decode: (producer) => Effect.succeed(producer),
  encode: (producer) => producer.kind === "launch"
    ? Effect.fail(new SchemaIssue.Forbidden({ message: "chat.entries.appended version 5 cannot store a launch producer" }))
    : Effect.succeed(producer),
});

const ProducerV5Schema = ProducerV5VocabularySchema.pipe(Schema.decodeTo(CurrentProducerSchema, producerV5ToCurrent));

/** `chat.entries.appended` version 4 stored a session producer with no
 *  envelope. It decodes unchanged into the version 5 producer, whose envelope
 *  is absent. Remove this version after 2027-04-03, when no store holds it. */
const ProducerV4Schema = Schema.Union([
  HumanProducerSchema,
  Schema.Struct(sessionProducerFields),
]).pipe(Schema.decodeTo(
  ProducerV5VocabularySchema,
  SchemaTransformation.transform({
    decode: (producer) => producer,
    encode: (producer) => producer.kind === "human"
      ? producer
      : { kind: producer.kind, sessionId: producer.sessionId, conversationId: producer.conversationId, toolUseId: producer.toolUseId, hop: producer.hop },
  }),
)).pipe(Schema.decodeTo(CurrentProducerSchema, producerV5ToCurrent));

/** Before session messages, `chat.entries.appended` versions 1 to 3 named a
 *  parent's message with a `parent-agent` producer. It decodes as the session
 *  producer of that parent with hop 0, so every reader sees one producer
 *  shape. A current writer cannot produce it: version 3 stays current only
 *  for a batch with no session or launch producer, which an earlier build
 *  still reads.
 *  Remove the `parent-agent` branch after 2027-04-03, when no store holds an
 *  entry with that producer. */
const ProducerV3Schema = Schema.Union([
  HumanProducerSchema,
  Schema.Struct({
    kind: Schema.Literal("parent-agent"),
    parentSessionId: Schema.NonEmptyString,
    parentConversationId: Schema.NonEmptyString,
    authorizingToolCallId: Schema.NonEmptyString,
  }),
]).pipe(Schema.decodeTo(
  ProducerV5VocabularySchema,
  SchemaTransformation.transform({
    decode: (producer) => producer.kind === "human"
      ? producer
      : { kind: "session" as const, sessionId: producer.parentSessionId, conversationId: producer.parentConversationId, toolUseId: producer.authorizingToolCallId, hop: 0 },
    encode: (producer) => producer.kind === "human"
      ? producer
      : { kind: "parent-agent" as const, parentSessionId: producer.sessionId, parentConversationId: producer.conversationId, authorizingToolCallId: producer.toolUseId },
  }),
)).pipe(Schema.decodeTo(CurrentProducerSchema, producerV5ToCurrent));

const SystemAgentMessageSchema = Schema.Struct({
  kind: Schema.Literal("system"),
  content: Schema.String,
  /** Structured evidence behind a learning review notice: every skill
   *  write the notice reports, in the order the review fork made them, each
   *  with the canonical artifact of what it changed. `content` stays the
   *  authority for what the reader is told; these records are only the
   *  evidence under it, and never enter the model-visible context. */
  reviewMutations: Schema.optionalKey(Schema.Array(ReviewNoticeMutationSchema)),
});

const ReferenceSystemAgentMessageSchema = Schema.Struct({
  kind: Schema.Literal("system"),
  content: Schema.String,
  ...ReferenceReviewNoticeFields,
});

/** A recorded decision that repairs conversation content a provider refused.
 *  `content` is the one note of the decision: the person reads it in the
 *  transcript and the rebuilt context gives the same text to the model. */
const ContentRepairSystemAgentMessageSchema = Schema.Struct({
  kind: Schema.Literal("system"),
  content: Schema.String,
  contentRepair: ContentRepairSchema,
});

const CompactionSummaryAgentMessageSchema = Schema.Struct({
  kind: Schema.Literal("compactionSummary"),
  content: Schema.String,
});

const ToolResultMessageSchema = Schema.Struct({
  kind: Schema.Literal("toolResult"),
  toolUseId: Schema.String,
  content: Schema.mutable(Schema.Array(LlmToolOutputPartSchema)).check(Schema.isNonEmpty()),
  isError: Schema.optionalKey(Schema.Boolean),
  interrupted: Schema.optionalKey(Schema.Boolean),
  blocked: Schema.optionalKey(Schema.Boolean),
});

/** Stored toolResult message: content parts may be
 *  tool-content reference parts beside the inline parts (tool output dedup).
 *  The conversation fold resolves reference parts back to inline text parts at
 *  its entry parse point, so this shape never leaves the parse seam. */
const StoredToolResultMessageSchema = Schema.Struct({
  ...ToolResultMessageSchema.fields,
  content: Schema.mutable(Schema.Array(Schema.Union([LlmToolOutputPartSchema, ToolContentReferencePartSchema]))).check(Schema.isNonEmpty()),
});

/** The entry schemas of one producer vocabulary. The current version stores
 *  the producer it reads; earlier versions decode their producer into it.
 *  `AssistantSchema` is the assistant shape of the unstored entry; a stored
 *  entry always has the stored assistant shape. */
function entrySchemas<P extends Schema.Codec<typeof CurrentProducerSchema.Type, unknown>, A extends typeof StoredAssistantAgentMessageSchema | typeof AssistantAgentMessageSchema, S extends Schema.Top>(producer: P, AssistantSchema: A, SystemSchema: S) {
  const UserAgentMessageSchema = Schema.Struct({
    kind: Schema.Literal("user"),
    content: PersistedContentSchema,
    /** Absent provenance remains unknown; role alone never proves human input. */
    origin: Schema.optionalKey(Schema.Literals(["human", "system"])),
    checkpoint: Schema.optionalKey(Schema.Literal(true)),
    producer: Schema.optionalKey(producer),
    /** Inline step/skill invocation display metadata: the content is the full
     *  expanded prompt (model-visible); transcript projection renders a
     *  divider labeled `label` plus the optional raw `args`
     *  instead of the content. */
    invocation: Schema.optionalKey(Schema.Struct({ label: Schema.String, args: Schema.optionalKey(Schema.String) })),
    submissionIds: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
    replyRequired: Schema.optionalKey(Schema.Literal(true)),
    runtimeNotice: Schema.optionalKey(Schema.Literal(true)),
    // `conversation-tier` is the label that builds before 2026-10-27 wrote on a hosted agent's tier entries and tool
    // notice. The reader converts it (`persistedToConversationMessage`); remove it after 2027-04-27.
    framing: Schema.optionalKey(Schema.Literals(["claude", "model", "agent-host", "tool-notice", "reminder", "conversation-tier"])),
  });

  const PersistedAgentMessageSchema = Schema.Union([
    AssistantSchema,
    UserAgentMessageSchema,
    SystemSchema,
    CompactionSummaryAgentMessageSchema,
    ToolResultMessageSchema,
  ]);

  const StoredPersistedAgentMessageSchema = Schema.Union([
    StoredAssistantAgentMessageSchema,
    UserAgentMessageSchema,
    SystemSchema,
    CompactionSummaryAgentMessageSchema,
    StoredToolResultMessageSchema,
  ]);

  const messageEntryFields = {
    ...baseEntryFields,
    kind: Schema.Literal("message"),
    /** Durable request-ledger key for a post-workflow follow-up user turn. */
    followUpRequestSequence: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    /** When true, the entry is persisted for diagnostic/UI inspection but is
     *  omitted from the model-visible context the next provider request sees.
     *  Used for system-internal messages (errors, diagnostics) that should be
     *  inspectable later without polluting the model's view of history. */
    displayOnly: Schema.optionalKey(Schema.Boolean),
  };

  const MessageEntrySchema = Schema.Struct({
    ...messageEntryFields,
    message: PersistedAgentMessageSchema,
  });

  const StoredMessageEntrySchema = Schema.Struct({
    ...messageEntryFields,
    message: StoredPersistedAgentMessageSchema,
  });
  return { PersistedAgentMessageSchema, MessageEntrySchema, StoredMessageEntrySchema };
}

const current = entrySchemas(CurrentProducerSchema, AssistantAgentMessageSchema, Schema.Union([SystemAgentMessageSchema, ReferenceSystemAgentMessageSchema, ContentRepairSystemAgentMessageSchema]));
const v8 = entrySchemas(CurrentProducerSchema, StoredAssistantAgentMessageSchema, Schema.Union([ReferenceSystemAgentMessageSchema, ContentRepairSystemAgentMessageSchema]));
const v7 = entrySchemas(CurrentProducerSchema, StoredAssistantAgentMessageSchema, ReferenceSystemAgentMessageSchema);
const v6 = entrySchemas(CurrentProducerSchema, StoredAssistantAgentMessageSchema, SystemAgentMessageSchema);
const v5 = entrySchemas(ProducerV5Schema, StoredAssistantAgentMessageSchema, SystemAgentMessageSchema);
const v4 = entrySchemas(ProducerV4Schema, StoredAssistantAgentMessageSchema, SystemAgentMessageSchema);
const v3 = entrySchemas(ProducerV3Schema, StoredAssistantAgentMessageSchema, SystemAgentMessageSchema);

export const PersistedAgentMessageSchema = current.PersistedAgentMessageSchema;
export const MessageEntrySchema = current.MessageEntrySchema;

const RetainedUserMessageSchema = Schema.Struct({
  kind: Schema.Literal("user"),
  content: Schema.NonEmptyString,
  origin: Schema.optionalKey(Schema.Literal("human")),
  submissionIds: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
});

const compactionEntryFields = {
  ...baseEntryFields,
  kind: Schema.Literal("compaction"),
  sourceLeafId: Schema.NonEmptyString,
  tokensBefore: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  tokensAfter: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  details: Schema.optionalKey(Schema.Unknown),
  fromHook: Schema.optionalKey(Schema.Boolean),
};

export const CompactionEntrySchema = Schema.Union([
  Schema.Struct({ ...compactionEntryFields, mode: Schema.Literal("reset") }),
  Schema.Struct({ ...compactionEntryFields, mode: Schema.optionalKey(Schema.Literal("summary")), summary: Schema.String, retainedMessages: Schema.Array(RetainedUserMessageSchema) }),
]);

export const BranchSummaryEntrySchema = Schema.Struct({
  ...baseEntryFields,
  kind: Schema.Literal("branch_summary"),
  fromId: Schema.NonEmptyString,
  summary: Schema.String,
  details: Schema.optionalKey(Schema.Unknown),
  fromHook: Schema.optionalKey(Schema.Boolean),
});

export const LabelEntrySchema = Schema.Struct({
  ...baseEntryFields,
  kind: Schema.Literal("label"),
  targetId: Schema.NonEmptyString,
  label: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
});

const SessionInfoEntrySchema = Schema.Struct({
  ...baseEntryFields,
  kind: Schema.Literal("session_info"),
  name: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
});

export const LeafEntrySchema = Schema.Struct({
  ...baseEntryFields,
  kind: Schema.Literal("leaf"),
  targetId: Schema.NullOr(Schema.NonEmptyString),
});

const otherEntrySchemas = [CompactionEntrySchema, BranchSummaryEntrySchema, LabelEntrySchema, SessionInfoEntrySchema, LeafEntrySchema] as const;

export const ConversationEntrySchema = Schema.Union([current.MessageEntrySchema, ...otherEntrySchemas]);

/** The current stored entry union: identical to
 *  ConversationEntrySchema except that toolResult content parts may be
 *  tool-content references. The fold hydrates this one back to
 *  ConversationEntry before anything downstream sees it. */
const StoredConversationEntrySchema = Schema.Union([current.StoredMessageEntrySchema, ...otherEntrySchemas]);

/** Version 8 also stores content-repair decisions. */
export const StoredConversationEntryV8Schema = Schema.Union([v8.StoredMessageEntrySchema, ...otherEntrySchemas]);

/** Version 7 retains review evidence as one bounded manifest, never inline patches. */
export const StoredConversationEntryV7Schema = Schema.Union([v7.StoredMessageEntrySchema, ...otherEntrySchemas]);

/** Inline mutation evidence written before 2026-10-16 is normalized at the family recovery boundary. Remove this conversion after 2027-04-16. */
export const StoredConversationEntryV6Schema = Schema.Union([v6.StoredMessageEntrySchema, ...otherEntrySchemas]);

/** Version 5 of the stored entry union: the current shape with no launch
 *  producer. */
export const StoredConversationEntryV5Schema = Schema.Union([v5.StoredMessageEntrySchema, ...otherEntrySchemas]);

/** Version 4 of the stored entry union: the version 5 shape whose session
 *  producer carries no envelope. */
export const StoredConversationEntryV4Schema = Schema.Union([v4.StoredMessageEntrySchema, ...otherEntrySchemas]);

/** Version 3 of the stored entry union: the current shape with the earlier
 *  producer vocabulary, decoded into the current one. */
export const StoredConversationEntryV3Schema = Schema.Union([v3.StoredMessageEntrySchema, ...otherEntrySchemas]);
const ConversationEntryV3Schema = Schema.Union([v3.MessageEntrySchema, ...otherEntrySchemas]);

export type StoredConversationEntry = typeof StoredConversationEntrySchema.Type;

function hasHistoricalProvenance(entry: StoredConversationEntry): boolean {
  if (entry.kind === "message" && entry.message.kind === "user") return entry.message.origin !== "human";
  if (entry.kind === "compaction") return entry.mode !== "reset" && entry.retainedMessages.every((message) => message.origin === undefined);
  return true;
}

/** Versions 1 and 2 predate explicit human provenance, including retained input. */
export const HistoricalConversationEntrySchema = ConversationEntryV3Schema.check(Schema.makeFilter(hasHistoricalProvenance));
export const HistoricalStoredConversationEntrySchema = StoredConversationEntryV3Schema.check(Schema.makeFilter(hasHistoricalProvenance));
