import { createEventProjection, parseProjectionFact } from "../../infra/event-projection.js"
import type { AsyncEventReadSurface, StoredFact } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import { heldProjection } from "../../infra/projection-registry.js"
import type { BackgroundCommandRecord } from "../../infra/runtime-fact-types.js"
import { parseSessionRuntimeFact } from "./session-runtime-event-types.js"

const log = Log.create({ service: "background-index-projection" })

const BACKGROUND_COMMAND_FACT_TYPES = ["tool.background_command.recorded"] as const
/** The record version this build reads. */
const KNOWN_VERSION = 1

interface BackgroundCommandsState {
  /** The newest record of each command, keyed by its tool use id. */
  readonly commands: Map<string, BackgroundCommandRecord>
}

/** The background commands of one session, as their newest records state
 *  them. The projection holds no output and no titles beyond the command
 *  description, and no owner feeds it, so every read folds what is new. */
export async function readBackgroundCommands(reader: AsyncEventReadSurface, sessionId: string): Promise<ReadonlyMap<string, BackgroundCommandRecord>> {
  const state = await heldProjection(reader, `background-index:${sessionId}`, () => createEventProjection<BackgroundCommandsState>(reader, {
    name: "background-index",
    aggregateId: `session:${sessionId}`,
    factTypes: BACKGROUND_COMMAND_FACT_TYPES,
    initialState: () => ({ commands: new Map() }),
    draft: (current) => ({ commands: new Map(current.commands) }),
    reduce: reduceBackgroundCommand,
  })).replay()
  return state.commands
}

function reduceBackgroundCommand(state: BackgroundCommandsState, event: StoredFact): BackgroundCommandsState {
  // A row a newer build wrote stays in the store untouched; this build only
  // leaves it out of the index.
  if (event.version !== KNOWN_VERSION) {
    log.warn("a background command record has a version this build cannot read; the index leaves it out", { sessionId: event.sessionId, eventId: event.id, version: event.version })
    return state
  }
  const fact = parseProjectionFact(event, parseSessionRuntimeFact)
  if (fact.type !== "tool.background_command.recorded") return state
  state.commands.set(fact.payload.toolUseId, fact.payload)
  return state
}
