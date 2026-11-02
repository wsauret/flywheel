// "blocked" is an in-process outcome for wait-state tool results (e.g. the
// handoff tool's subagent gate): the model sees an error
// (toolOutcomeToProviderIsError), but bookkeeping that counts real failures
// (the handoff correction bound) skips it by type.
//
// "cancelled" is an in-process outcome for user-initiated declination (the
// user dismissed an ask_user question, an operator aborted a launched task).
// The model still sees it as an error so it never mistakes a declination for
// an answer, but error-rate bookkeeping skips it: nothing failed.
//
// "stopped" is a person's Stop of a child's run (a subagent or a workflow)
// through its parent's tool call. It is terminal and distinct from the
// requesting agent's own cancellation ("cancelled"), so every surface can say
// who ended the run. The model sees it as an error: the call failed.
//
// None of these is ever read back from the provider wire, which only carries
// is_error/interrupted. "stopped" is an additive value in durable
// `tool.result.recorded` facts: every older fact still reads unchanged.
export const TOOL_OUTCOME_VALUES = ["ok", "error", "interrupted", "blocked", "cancelled", "stopped"] as const

export type ToolOutcome = typeof TOOL_OUTCOME_VALUES[number]

/** What the requesting agent does after a person's Stop ends work it
 *  started: a subagent, a workflow, or a background command. The Stop is the
 *  person's decision, so the model must not take the stopped work back up on
 *  its own. Every result of a person's Stop ends with these words. */
export const PERSON_STOP_INSTRUCTION = "Do not redo the stopped work. Tell the user it stopped and wait for their direction."

export function toolOutcomeFromProvider(isError: boolean | undefined, interrupted: boolean | undefined): ToolOutcome {
  if (interrupted === true) return "interrupted"
  return isError === true ? "error" : "ok"
}

export function toolOutcomeToProviderIsError(outcome: ToolOutcome): boolean {
  return outcome !== "ok"
}
