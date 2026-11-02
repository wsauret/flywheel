import { Schema } from "effect";

export type SessionKind = "workflow-agent" | "chat" | "subagent"

export const SESSION_LIFECYCLE_STATES = ["active", "inactive"] as const;

// Persisted lifecycle marker: active means the manager has a live runner,
// inactive means no runner exists. Workflow progress (paused/completed/failed)
// lives in the queue projection; this field never encodes it.
export const SessionLifecycleStateSchema = Schema.Literals(SESSION_LIFECYCLE_STATES);
export type SessionLifecycleState = typeof SessionLifecycleStateSchema.Type;

const VALID_TRANSITIONS: Readonly<SessionLifecycleTransitions> = Object.freeze({
  active: ["inactive"],
  inactive: ["active"],
} satisfies SessionLifecycleTransitions);

export function isValidTransition(from: SessionLifecycleState, to: SessionLifecycleState): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export function isResumable(lifecycleState: SessionLifecycleState): boolean {
  return lifecycleState === "inactive";
}
interface SessionLifecycleTransitions {
  active: readonly SessionLifecycleState[]
  inactive: readonly SessionLifecycleState[]
}
