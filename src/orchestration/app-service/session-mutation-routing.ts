import { assertNever } from "../../infra/assert-never.js"
import type { FrontendMutation } from "../../protocol/app-service-types.js"

/** The public app-service chat/session/question mutation tags that route to a
 *  per-session runtime. Workflow and auth tags route elsewhere and are not the
 *  actor's concern, and `session.send` routes by the kind of its session first
 *  (`handleSessionSend`): a message to a chat reaches the actor's mailbox as
 *  its ordered `session.send`. Reusing the dot-delimited `FrontendMutation` tags keeps one
 *  vocabulary across transport, the classifier, and the supervisor - there is
 *  no second translation table to drift. `ChatMutationTag` derives from the
 *  runtime tuple so the routing switch remains exhaustive. */
const CHAT_MUTATION_TAGS = ["session.changes.undo", "chat.open", "chat.compact", "chat.interrupt", "chat.resume", "bash.detach", "background.terminate", "session.activate", "session.release", "session.fork", "session.close", "session.discard_transient", "session.delete", "session.rename", "session.reorder", "session.dismiss_notice", "question.answer", "question.cancel"] as const

export type ChatMutationTag = Extract<FrontendMutation, { type: (typeof CHAT_MUTATION_TAGS)[number] }>["type"]


/** Ordered commands enter exactly one serialized intake per session and resolve
 *  when their live coordination work is done. They never wait for a whole
 *  assistant turn. Encoded with the existing dot-delimited tags so the actor and
 *  the frontend speak one mutation vocabulary - these are exactly the tags the
 *  actor's `SessionMutation` mailbox accepts. `chat.open`/`session.activate` route
 *  stateful but mint or load a session ahead of the mailbox rather than entering
 *  it, so they are `supervisor` commands, not members here. `session.rename` is
 *  ordered because it can materialize a transient chat's durable row; the
 *  mailbox serializes it against a cold send's own materialization.
 *  `session.release` is ordered so it ends the runner only after an
 *  activation or a send queued before it. */
type OrderedSessionMutation =
  | { readonly kind: "session.changes.undo" }
  | { readonly kind: "chat.resume" }
  | { readonly kind: "question.answer" }
  | { readonly kind: "background.terminate" }
  | { readonly kind: "question.cancel" }
  | { readonly kind: "chat.compact" }
  | { readonly kind: "session.rename" }
  | { readonly kind: "session.release" }

/** Two-phase lifecycle commands. Phase one calls the preemptive `markClosing`
 *  synchronously so generation is invalidated before any ordered queue wait can
 *  attach a stale runner; phase two performs ordered tombstone-or-deactivate
 *  cleanup. The `preflight` field type-checks that every lifecycle mutation
 *  carries the synchronous mark, distinguishing it from a plain ordered mutation
 *  that may wait behind the mailbox immediately. */
type LifecycleSessionMutation =
  | { readonly kind: "session.close"; readonly preflight: "markClosing" }
  | { readonly kind: "session.delete"; readonly preflight: "markClosing" }
  | { readonly kind: "session.discard_transient"; readonly preflight: "markClosing" }

/** Preemptive signals bypass the ordered mailbox and act synchronously on the
 *  active turn's abort scope. They never queue. `mark-closing` is the first
 *  phase of a lifecycle mutation, exposed here as the preemptive primitive
 *  lifecycle handlers call before awaiting startup. There is no `deactivate`
 *  signal: deactivation is private actor cleanup chosen after a
 *  tombstone-or-inactivate decision, not a routed mutation. */
type PreemptiveSessionSignal =
  | { readonly kind: "interrupt-current-turn" }
  | { readonly kind: "release-foreground-bash" }
  | { readonly kind: "abort-current-turn" }
  | { readonly kind: "mark-closing" }

/** The routing category for a public chat mutation. `ordered` and `lifecycle`
 *  carry the typed mutation that enters the actor mailbox. `supervisor` commands
 *  (`chat.open`/`session.activate`) are stateful but mint or load a session ahead
 *  of the mailbox, so they have no `SessionMutation` body. `out-of-actor` is list
 *  ordering that never touches per-session runtime state. Each typed
 *  mutation/signal carries the matching category as its own discriminant so the
 *  route a tag maps to and the mutation it produces are one value, not two that
 *  can drift. */
export type ChatMutationRoute =
  | { readonly category: "ordered"; readonly mutation: OrderedSessionMutation }
  | { readonly category: "lifecycle"; readonly mutation: LifecycleSessionMutation }
  | { readonly category: "preemptive"; readonly signal: PreemptiveSessionSignal }
  | { readonly category: "supervisor"; readonly kind: "chat.open" | "session.activate" | "session.fork" }
  | { readonly category: "out-of-actor"; readonly kind: "session.reorder" | "session.dismiss_notice" }

/** Classify a public chat mutation into its routing category and typed mutation.
 *  Tag-only: it reads the discriminant and never touches a mutation's
 *  `ChatInputLike` payload, so no body is cloned, serialized, or retained. The
 *  exhaustive switch is the contract consumer the rest of the plan depends on --
 *  a new `ChatMutationTag`, or a new `OrderedSessionMutation`/`LifecycleSessionMutation`
 *  variant, fails to compile until it is classified here. The dot-delimited tags
 *  are the one shared mutation vocabulary across transport, classifier, and
 *  supervisor. */
export function classifyChatMutation(tag: ChatMutationTag): ChatMutationRoute {
  switch (tag) {
    case "session.changes.undo":
    case "chat.resume":
    case "question.answer":
    case "background.terminate":
    case "question.cancel":
    case "chat.compact":
    case "session.rename":
    case "session.release":
      return { category: "ordered", mutation: { kind: tag } }
    case "chat.open":
    case "session.fork":
    case "session.activate":
      return { category: "supervisor", kind: tag }
    case "session.close":
    case "session.delete":
    case "session.discard_transient":
      return { category: "lifecycle", mutation: { kind: tag, preflight: "markClosing" } }
    case "chat.interrupt":
      return { category: "preemptive", signal: { kind: "interrupt-current-turn" } }
    case "bash.detach":
      return { category: "preemptive", signal: { kind: "release-foreground-bash" } }
    case "session.reorder":
    case "session.dismiss_notice":
      return { category: "out-of-actor", kind: tag }
    default:
      return assertNever(tag)
  }
}
