export const CONTINUATION_MESSAGES = {
  unexpected_exit: "Your process exited unexpectedly. Continue where you left off.",
  // A Resume of an interrupted turn. The turn-end record before it says who
  // interrupted the turn; this message is the only one that asks to continue.
  resumed: "The interrupted turn is resumed. Continue it from where it stopped; do not repeat work that finished.",
  subagent_resumed: "Continue the saved assignment from where it stopped. Do not repeat work that finished.",
  stream_stalled: "Your previous response stalled while composing one oversized operation. Produce one small sequential batch in this response. For an edit or generated payload, produce one small section. For parallel calls, launch one small batch. Do not retry the oversized operation as one tool call, and do not wait for the user. Normal batching resumes after this response completes.",
} as const

/** The continuation of a failed workflow agent that a person or its parent
 *  resumed, with `failure`, the reason its attempt recorded. */
export function reopenedContinuation(failure: string): string {
  return `Your previous attempt at this work failed, and a person or your parent resumed you. The recorded failure: ${failure}\n\nContinue from where you stopped. Do not repeat work that finished. Finish with your handoff.`
}
