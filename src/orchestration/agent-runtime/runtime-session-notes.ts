import { canUseCheckpoint, renderSessionNotesGuidance } from "../../infra/agent-assets/session-notes.js";
import type { DurableOwner } from "../../infra/durable-owner.js";
import { createConversationCheckpointOwner } from "../session/conversation-checkpoint.js";
import { importLegacyCheckpointNotes } from "../session/checkpoint-note-conversion.js";
import type { ConversationResources } from "../session/conversation-resources.js";
import type { AgentOptions, HeadlessPrompt } from "./types.js";
import type { AgentLoopOptions } from "./agent-loop-types.js";
import type { RequestToolSurfaceOwner } from "./request-tool-surface.js";

/** The conversation's checkpoint owner, or undefined when the run has no durable conversation to keep one for. It
 *  reads and writes nothing until a tool calls it. */
export function createRuntimeSessionNotes(
  options: AgentOptions,
  conversationId: string | undefined,
  owner: DurableOwner | undefined,
): AgentLoopOptions["checkpoint"] {
  const reader = options.sessionEventReader ?? options.sessionEventStore;
  const writer = options.sessionEventWriter;
  if (!conversationId || !owner || !reader || !writer) return undefined;
  return createConversationCheckpointOwner(reader, writer, owner, conversationId);
}

/** Imports the conversation's checkpoint notes that a build before the checkpoint kept as Markdown files, once. It
 *  writes durable facts, so only a send runs it. */
export async function importLegacyRuntimeSessionNotes(
  resources: ConversationResources,
  options: AgentOptions,
  conversationId: string | undefined,
  owner: DurableOwner | undefined,
): Promise<void> {
  const reader = options.sessionEventReader ?? options.sessionEventStore;
  const writer = options.sessionEventWriter;
  if (!conversationId || !owner || !reader || !writer || !resources.notesDirectory) return;
  await importLegacyCheckpointNotes(reader, writer, owner, conversationId, resources.notesDirectory);
}

export function assembleInitialRequestContextWithSessionNotes(
  headlessPrompt: HeadlessPrompt | undefined,
  requestContext: string | undefined,
  checkpoint: AgentLoopOptions["checkpoint"],
  toolSurface: RequestToolSurfaceOwner,
): AgentLoopOptions["initialRequestContext"] {
  if (headlessPrompt?.kind !== "literal" || !checkpoint) return requestContext;

  const request = toolSurface.current();
  if (!canUseCheckpoint(true, request.tools)) return requestContext;

  return [requestContext, renderSessionNotesGuidance({ has: request.capabilities })].filter((text) => text !== undefined).join("\n\n");
}
