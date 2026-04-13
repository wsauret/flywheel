import { z } from "zod";

export const SessionStateSchema = z.enum(["active", "paused", "completed"]);
export type SessionState = z.infer<typeof SessionStateSchema>;

export const VALID_TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> = Object.freeze({
  active: ["paused", "completed"],
  paused: ["active"],
  completed: [],
});

export function isValidTransition(from: SessionState, to: SessionState): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export function isResumable(state: SessionState): boolean {
  return state === "paused";
}
