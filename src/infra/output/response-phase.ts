import type { StreamPhase } from "../output-blocks.js";

/** The live phase of the current model response. `since` is when the work
 *  that the next new thinking block shows began: the start of the model call
 *  or of thinking. The first thinking block claims it (null), and every move
 *  to another phase ends it with the phase. */
export type ResponsePhase =
  | { readonly kind: "waiting" | "thinking"; readonly since: number | null }
  | { readonly kind: "generating" | "tool_executing" };

/** What moves the response phase. `entered` is a phase the projector drives,
 *  `ended` closes the response, and `claimed` is a new block that takes the
 *  anchor, so the next new thinking block starts at its own time. */
type ResponsePhaseEvent =
  | { readonly kind: "entered"; readonly phase: StreamPhase; readonly at: number }
  | { readonly kind: "ended" }
  | { readonly kind: "claimed" };

export const anchorOf = (phase: ResponsePhase | null): number | null =>
  phase !== null && "since" in phase ? phase.since : null;

/** The one transition of the response phase. */
export function nextResponsePhase(current: ResponsePhase | null, event: ResponsePhaseEvent): ResponsePhase | null {
  if (event.kind === "ended") return null;
  if (event.kind === "claimed") return current !== null && "since" in current ? { kind: current.kind, since: null } : current;
  switch (event.phase) {
    case "waiting": return { kind: "waiting", since: event.at };
    case "thinking": return { kind: "thinking", since: anchorOf(current) ?? event.at };
    default: return { kind: event.phase };
  }
}
