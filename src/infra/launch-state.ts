/** The place a terminal hands to the build that replaces it.
 *
 *  When the account service starts speaking a protocol this terminal cannot
 *  speak, the terminal re-executes the build that serves (ARCH-RUNTIME-036). The
 *  predecessor writes what the person was looking at into one private file and
 *  names it in the successor's environment (`LAUNCH_STATE_ENV`); the successor
 *  reads it once, deletes it, and restores the same session, tabs, drafts,
 *  expanded rows, and scroll place.
 *
 *  The two processes can run different builds, so the file is a versioned
 *  contract between releases, parsed strictly. A reader that meets a version
 *  or a shape it does not know starts plain and says why; it never guesses. */

import { randomUUID } from "node:crypto"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Schema } from "effect"

import { errorMessage } from "./error-message.js"

export const LAUNCH_STATE_VERSION = 3

const Paste = Schema.Struct({ start: Schema.Number, end: Schema.Number, text: Schema.String })
const Attachment = Schema.Struct({ marker: Schema.String, mediaType: Schema.String, data: Schema.String, name: Schema.optionalKey(Schema.String) })
const Draft = Schema.Struct({ text: Schema.String, pastes: Schema.Array(Paste), attachments: Schema.Array(Attachment), caret: Schema.Number })
const QuestionDraft = Schema.Struct({
  tab: Schema.Number,
  cursor: Schema.Number,
  answers: Schema.Array(Schema.Struct({ picked: Schema.Array(Schema.Number), freeformPicked: Schema.Boolean })),
  editorText: Schema.Array(Schema.Array(Schema.String)),
})
/** Following the live end, or held at a row: the block's absolute index in
 *  the session's output and the rows scrolled into it. The index is the
 *  runtime's own and the same in every client; a block's identity is not,
 *  because a block a client saw streaming carries its live id and a fresh
 *  read carries the durable one. Measured offsets are per process and never
 *  travel. */
const Scroll = Schema.Union([
  Schema.Struct({ tail: Schema.Literal(true) }),
  Schema.Struct({ blockIndex: Schema.Number, rowOffsetWithinBlock: Schema.Number }),
])
const Modal = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("sessions") }),
  Schema.Struct({ kind: Schema.Literal("child"), sessionId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("module"), moduleId: Schema.String, route: Schema.Json }),
  /** A workflow agent's view, which a successor reopens over the
   *  workflow's full-size card. A `child` route of a workflow reopens the
   *  card alone. */
  Schema.Struct({ kind: Schema.Literal("theme") }),
])
/** One message the predecessor sent that the runtime had not answered, with
 *  the submission identity the successor sends it again under. */
const Unsent = Schema.Struct({
  sessionId: Schema.String,
  id: Schema.String,
  input: Schema.Struct({
    text: Schema.String,
    attachments: Schema.optionalKey(Schema.Array(Attachment)),
    invocation: Schema.optionalKey(Schema.Struct({ label: Schema.String, args: Schema.optionalKey(Schema.String) })),
    submissionIds: Schema.Array(Schema.String),
  }),
  timestamp: Schema.Number,
})
const LaunchStateSchema = Schema.Struct({
  version: Schema.Literal(LAUNCH_STATE_VERSION),
  projectRoot: Schema.String,
  foreground: Schema.NullOr(Schema.String),
  tabs: Schema.Array(Schema.String),
  scroll: Schema.Record(Schema.String, Scroll),
  /** Per session, block identity to expanded. A tool row's identity is its
   *  tool use id, the same in every client. */
  disclosure: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Boolean)),
  /** Composer drafts by session id, with the caret. */
  drafts: Schema.Record(Schema.String, Draft),
  /** Question forms by session id, then tool use id. */
  questionDrafts: Schema.Record(Schema.String, Schema.Record(Schema.String, QuestionDraft)),
  modal: Modal,
  /** The messages on their way or waiting for the connection, which the
   *  successor shows queued and sends again on its first lane. A writer
   *  omits the field when no message waits, so a successor of an older
   *  build still reads the file of a terminal with nothing waiting. */
  outbox: Schema.optionalKey(Schema.Array(Unsent)),
})

export type LaunchState = typeof LaunchStateSchema.Type
export type LaunchUnsent = typeof Unsent.Type

/** The messages a launch state hands over unanswered, none when the field
 *  is absent. This reads the shape that builds before 2026-10-22 write,
 *  which has no `outbox` field. After 2027-04-22 no successor reads a file
 *  of such a build; absence then means only that nothing waited, and the
 *  older-shape test in `launch-state.test.ts` can go. */
export function launchOutbox(state: LaunchState): readonly LaunchUnsent[] {
  return state.outbox ?? []
}
export type LaunchScroll = typeof Scroll.Type
export type LaunchModalRoute = typeof Modal.Type

const decodeLaunchState = Schema.decodeUnknownSync(LaunchStateSchema, { onExcessProperty: "error" })
// Remove after 2027-04-02, once terminal replacements no longer originate on v1.
const LaunchStateV1Schema = Schema.Struct({
  ...LaunchStateSchema.fields,
  version: Schema.Literal(1),
  modal: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("none") }),
    Schema.Struct({ kind: Schema.Literal("sessions") }),
    Schema.Struct({ kind: Schema.Literal("subagent"), sessionId: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("theme") }),
  ]),
})
const decodeLegacyLaunchState = Schema.decodeUnknownSync(LaunchStateV1Schema, { onExcessProperty: "error" })
// Remove after 2027-10-17. Version 2 named workflow routes with a session field.
const decodeV2 = Schema.decodeUnknownSync(Schema.Struct({
  ...LaunchStateSchema.fields, version: Schema.Literal(2),
  modal: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("none") }),
    Schema.Struct({ kind: Schema.Literal("sessions") }),
    Schema.Struct({ kind: Schema.Literal("theme") }),
    Schema.Struct({ kind: Schema.Literal("child"), sessionId: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("workflowAgent"), sessionId: Schema.String, agentNodeId: Schema.String, follow: Schema.Boolean }),
  ]),
}), { onExcessProperty: "error" })

/** Writes the state as one new owner-only file in `directory` and answers its
 *  path. The directory is the account service's private lane directory. */
export function writeLaunchState(directory: string, state: LaunchState): string {
  const path = join(directory, `launch-state-${process.pid}-${randomUUID()}.json`)
  writeFileSync(path, JSON.stringify(state), { mode: 0o600, flag: "wx" })
  return path
}

export type TakenLaunchState =
  | { readonly kind: "restore"; readonly state: LaunchState }
  | { readonly kind: "plain"; readonly reason: string }

/** Reads and removes the predecessor's file, converts the supported older shape, and refuses unknown shapes or a different project. */
export function takeLaunchState(path: string, projectRoot: string): TakenLaunchState {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (error) {
    return { kind: "plain", reason: `the launch state could not be read: ${errorMessage(error)}` }
  } finally {
    rmSync(path, { force: true })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { kind: "plain", reason: `the launch state is not JSON: ${errorMessage(error)}` }
  }
  // The version decides before the shape, so a newer writer is named as such
  // rather than reported as a malformed file.
  const version = typeof parsed === "object" && parsed !== null && "version" in parsed ? parsed.version : undefined
  if (version !== 1 && version !== 2 && version !== LAUNCH_STATE_VERSION) return { kind: "plain", reason: `the launch state has version ${String(version)}, and this build reads version ${LAUNCH_STATE_VERSION}` }
  let state: LaunchState
  try {
    if (version === 1) {
      const legacy = decodeLegacyLaunchState(parsed)
      state = { ...legacy, version: LAUNCH_STATE_VERSION, modal: legacy.modal.kind === "subagent" ? { kind: "child", sessionId: legacy.modal.sessionId } : legacy.modal }
    } else if (version === 2) {
      const legacy = decodeV2(parsed)
      state = { ...legacy, version: LAUNCH_STATE_VERSION, modal: legacy.modal.kind === "workflowAgent" ? { kind: "module", moduleId: "workflows", route: { workflowId: legacy.modal.sessionId, agentNodeId: legacy.modal.agentNodeId, follow: legacy.modal.follow } } : legacy.modal }
    } else state = decodeLaunchState(parsed)
  } catch (error) {
    return { kind: "plain", reason: `the launch state does not match version ${LAUNCH_STATE_VERSION}: ${errorMessage(error)}` }
  }
  if (state.projectRoot !== projectRoot) return { kind: "plain", reason: `the launch state names project ${state.projectRoot}, not ${projectRoot}` }
  return { kind: "restore", state }
}
