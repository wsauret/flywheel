import { Schema } from "effect"
import { ToolStreamingTextSchema } from "../infra/output-blocks.js"
export function runtimeSessionDetailResultSchema<
  Status extends Schema.Top,
  Budget extends Schema.Top,
  ChatRow extends Schema.Top,
  SubagentRow extends Schema.Top,
  MemberRow extends Schema.Top,
>(input: {
  readonly status: Status
  readonly budget: Budget
  readonly chatRow: ChatRow
  readonly subagentRow: SubagentRow
  readonly memberRow: MemberRow
}) {
  const liveBase = Schema.Struct({
    source: Schema.Literal("live"),
    id: Schema.String,
    streamingToolText: Schema.Record(Schema.String, ToolStreamingTextSchema),
    status: input.status,
    budget: input.budget,
  })
  const durableBase = Schema.Struct({
    source: Schema.Literal("durable"),
    id: Schema.String,
    status: input.status,
    budget: Schema.NullOr(input.budget),
  })
  const conversationFields = {
    conversationId: Schema.String,
    providerConversationId: Schema.optionalKey(Schema.String),
    seedContext: Schema.optionalKey(Schema.String),
  }
  const chat = Schema.Struct({ kind: Schema.Literal("chat"), row: input.chatRow, ...conversationFields })
  const subagent = Schema.Struct({ kind: Schema.Literal("subagent"), row: input.subagentRow, ...conversationFields })
  const member = Schema.Struct({ kind: Schema.Literal("workflow-agent"), row: input.memberRow, ...conversationFields })
  const view = Schema.Union([
    liveBase.pipe(Schema.fieldsAssign(chat.fields)),
    durableBase.pipe(Schema.fieldsAssign(chat.fields)),
    liveBase.pipe(Schema.fieldsAssign(subagent.fields)),
    durableBase.pipe(Schema.fieldsAssign(subagent.fields)),
    liveBase.pipe(Schema.fieldsAssign(member.fields)),
    durableBase.pipe(Schema.fieldsAssign(member.fields)),
  ])
  return Schema.Struct({ view: Schema.NullOr(view) })
}
