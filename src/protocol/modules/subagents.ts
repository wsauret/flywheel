import { Schema } from "effect"
import { defineProtocolModule, defineProtocolMutation } from "../protocol-module.js"

type SubagentControlResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string }

const SubagentControlResultSchema: Schema.Codec<SubagentControlResult> = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
])

/** The subagent-specific client mutations: the interrupt and resume of a
 * child's run (PI-AGENT-020). A message reaches a child through the kernel's
 * `session.send`, Stop terminates the parent's tool call with
 * `background.terminate`, and delete uses the ordinary per-session contract. */
export const subagentsProtocol = defineProtocolModule({
  id: "subagents",
  domains: [],
  mutations: [
    // Interrupt cuts the child's run at once and settles it as interrupted
    // by a person, keeping its binding; the parent keeps waiting.
    defineProtocolMutation({
      type: "subagent.interrupt",
      fields: { sessionId: Schema.NonEmptyString },
      result: SubagentControlResultSchema,
      policy: "lossless",
    }),
    // Resume continues the child from its recorded context under its
    // original parent binding, with no new message.
    defineProtocolMutation({
      type: "subagent.resume",
      fields: { sessionId: Schema.NonEmptyString },
      result: SubagentControlResultSchema,
      policy: "lossless",
    }),
  ],
})
