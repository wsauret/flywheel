import type { SessionEntry } from "../../src/orchestration/session-store/types.js"

/** The live session store entry of a chat session. */
export type ChatSessionEntry = Extract<SessionEntry, { kind: "chat" }>
