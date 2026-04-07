/**
 * Session Types
 *
 * Session-level discriminants and shared type definitions.
 */

/** Discriminant for what kind of session this is (workflow vs. interactive chat). */
export type SessionKind = "workflow" | "chat"
