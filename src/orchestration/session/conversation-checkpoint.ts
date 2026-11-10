import { Schema } from "effect";
import type { CapabilityCheck } from "../../infra/capability-text.js";
import { contentEvidence } from "../../infra/content-evidence.js";
import { durableOwnerAggregate, type DurableOwner } from "../../infra/durable-owner.js";
import { createEventProjection, parseProjectionFact } from "../../infra/event-projection.js";
import type { AsyncEventReadSurface } from "../../infra/event-store-types.js";
import { heldProjection } from "../../infra/projection-registry.js";
import { ConversationCheckpointSchema, parseConversationCheckpointFact, parseSessionIntentInheritedFact, type CheckpointDecision, type ConversationCheckpoint } from "./conversation-checkpoint-facts.js";
import type { SessionFactWriter } from "./session-fact-writer.js";

export const CHECKPOINT_LIMIT_BYTES = 24 * 1024;
export const CHECKPOINT_SECTIONS = ["designIntent", "decisions", "currentState", "openQuestions", "nextStep", "relevantSkills", "references", "workingNotes"] as const;
type CheckpointSection = typeof CHECKPOINT_SECTIONS[number];

/** A design intent as a writer may send it: `{text, approved}`, `{text}`, or the text alone. Only an explicit
 *  `approved: true` approves it; the other forms save an unapproved draft, which no child inherits (PI-AGENT-092). */
const DesignIntentInputSchema = Schema.Union([Schema.String, Schema.Struct({ text: Schema.String, approved: Schema.optionalKey(Schema.Boolean) })]);

/** The shape that `checkpoint_replace` accepts for `section`: its stored shape, or for the design intent every
 *  form of `DesignIntentInputSchema`. */
export function checkpointSectionInputSchema(section: CheckpointSection): Schema.Schema<unknown> {
  return section === "designIntent" ? DesignIntentInputSchema : ConversationCheckpointSchema.fields[section];
}

function storedDesignIntent(value: unknown): ConversationCheckpoint["designIntent"] {
  const intent = Schema.decodeUnknownSync(DesignIntentInputSchema, { onExcessProperty: "error" })(value);
  return typeof intent === "string" ? { text: intent, approved: false } : { text: intent.text, approved: intent.approved ?? false };
}

export function emptyConversationCheckpoint(): ConversationCheckpoint {
  return { designIntent: { text: "", approved: false }, decisions: [], currentState: "", openQuestions: "", nextStep: "", relevantSkills: [], references: [], workingNotes: "" };
}

/** Reads the latest checkpoint across all branches. Historical versions remain in the session fact log.
 * Storage and strict decoding failures propagate; absence returns undefined. */
export async function readConversationCheckpoint(reader: AsyncEventReadSurface, owner: DurableOwner, conversationId: string): Promise<ConversationCheckpoint | undefined> {
  const aggregateId = durableOwnerAggregate(owner);
  const projection = heldProjection(reader, `conversation-checkpoint:${aggregateId}:${conversationId}`, () => createEventProjection<{ checkpoint?: ConversationCheckpoint }>(reader, {
    name: "conversation-checkpoint",
    aggregateId,
    factTypes: ["conversation.checkpoint.updated"],
    initialState: () => ({}),
    reduce(state, event) {
      const fact = parseProjectionFact(event, parseConversationCheckpointFact);
      return fact.payload.conversationId === conversationId
        ? { checkpoint: fact.payload.checkpoint }
        : state;
    },
  }));
  return (await projection.replay()).checkpoint;
}

/** Renders exactly the approved intent and decisions for a child, or nothing for a draft. */
export function renderApprovedCheckpointIntent(checkpoint: ConversationCheckpoint): string | undefined {
  if (!checkpoint.designIntent.approved) return undefined;
  return `# Design intent (approved)\n\n${checkpoint.designIntent.text}\n\n${renderDecisions(checkpoint.decisions)}`;
}

/** The inherited intent that a subagent's publication recorded. A subagent
 *  that a build before 2026-10-27 published has none: its intent is a message
 *  in its history, as it was. Storage and decoding failures propagate. */
export async function readRecordedInheritedIntent(reader: AsyncEventReadSurface, sessionId: string): Promise<string | undefined> {
  const aggregateId = `session:${sessionId}`;
  const projection = heldProjection(reader, `inherited-intent:${aggregateId}`, () => createEventProjection<{ intent?: string }>(reader, {
    name: "inherited-intent",
    aggregateId,
    factTypes: ["session.intent.inherited"],
    initialState: () => ({}),
    reduce: (_state, event) => ({ intent: parseProjectionFact(event, parseSessionIntentInheritedFact).payload.intent }),
  }));
  return (await projection.replay()).intent;
}

/** Captures approved parent intent with its retained checkpoint identity. The child receives no write authority.
 * Absence and draft intent contribute nothing; storage and decoding failures propagate. */
export async function readInheritedCheckpointIntent(reader: AsyncEventReadSurface, sessionId: string, conversationId: string): Promise<string | undefined> {
  const checkpoint = await readConversationCheckpoint(reader, { kind: "session", sessionId }, conversationId);
  if (!checkpoint) return undefined;
  const intent = renderApprovedCheckpointIntent(checkpoint);
  if (intent === undefined) return undefined;
  return [
    "# Inherited design intent",
    `Source session: ${sessionId}\nSource conversation: ${conversationId}\nCheckpoint SHA-256: ${contentEvidence(JSON.stringify(checkpoint)).sha256}`,
    "This approved intent and the user's decisions are read-only inherited context. Work only on your assigned task. Report conflicts to your parent; do not change the parent's checkpoint.",
    intent,
  ].join("\n\n");
}

function renderDecisions(decisions: readonly CheckpointDecision[]): string {
  return `# Decisions\n\n${decisions.map((decision) => `## ${decision.date}\n\n${decision.words}\n\nReplaces: ${decision.replaces ?? "None"}`).join("\n\n")}`;
}

/** Renders all fixed sections for a reader with the capabilities `has`. An empty Relevant skills section renders only
 *  for a reader that can load skills. Oversized legacy Working notes become a size and paging pointer, never a partial
 *  note. */
export function renderConversationCheckpoint(checkpoint: ConversationCheckpoint, has: CapabilityCheck): string {
  const prefix = [
    `# Design intent (${checkpoint.designIntent.approved ? "approved" : "draft"})\n\n${checkpoint.designIntent.text}`,
    renderDecisions(checkpoint.decisions),
    `# Current state\n\n${checkpoint.currentState}`,
    `# Open questions\n\n${checkpoint.openQuestions}`,
    `# Next step\n\n${checkpoint.nextStep}`,
    ...(has("skill") || checkpoint.relevantSkills.length > 0 ? [`# Relevant skills\n\n${checkpoint.relevantSkills.map((skill) => `- ${skill.id}: ${skill.reason}`).join("\n")}`] : []),
    `# References\n\n${checkpoint.references.map((reference) => `- ${reference}`).join("\n")}`,
    "# Working notes",
  ].join("\n\n");
  const content = `${prefix}\n\n${checkpoint.workingNotes}`;
  if (Buffer.byteLength(content, "utf8") <= CHECKPOINT_LIMIT_BYTES) return content;
  return `${prefix}\n\nWorking notes is too large to include (${Buffer.byteLength(checkpoint.workingNotes, "utf8")} bytes). Read it with \`checkpoint_read({ "section": "workingNotes", "offset": 0 })\`, then repeat with each returned nextOffset until it is null. The stored checkpoint is unchanged.`;
}

/** A refused write names where the bytes are: an imported legacy checkpoint starts above the limit,
 * and every write fails until the agent shrinks the section that holds them. */
function sectionSizes(checkpoint: ConversationCheckpoint): string {
  const empty = emptyConversationCheckpoint();
  return CHECKPOINT_SECTIONS
    .map((section) => ({ section, json: JSON.stringify(checkpoint[section]) }))
    .filter(({ section, json }) => json !== JSON.stringify(empty[section]))
    .map(({ section, json }) => ({ section, bytes: Buffer.byteLength(json, "utf8") }))
    .toSorted((a, b) => b.bytes - a.bytes)
    .map(({ section, bytes }) => `${section} ${bytes}`)
    .join(", ");
}

export interface ConversationCheckpointOwner {
  read(): Promise<ConversationCheckpoint | undefined>;
  replace(section: CheckpointSection, value: unknown): Promise<ConversationCheckpoint>;
  decide(decision: CheckpointDecision): Promise<ConversationCheckpoint>;
}

/** Binds writes to one owning conversation. Tools accept no session or conversation target.
 * A write validates the complete resulting checkpoint and refuses oversized content without publishing it. */
export function createConversationCheckpointOwner(reader: AsyncEventReadSurface, writer: SessionFactWriter, owner: DurableOwner, conversationId: string): ConversationCheckpointOwner {
  const read = () => readConversationCheckpoint(reader, owner, conversationId);
  const save = async (checkpoint: ConversationCheckpoint): Promise<ConversationCheckpoint> => {
    const parsed = Schema.decodeUnknownSync(ConversationCheckpointSchema, { onExcessProperty: "error" })(checkpoint);
    const bytes = Buffer.byteLength(JSON.stringify(parsed), "utf8");
    if (bytes > CHECKPOINT_LIMIT_BYTES) throw new Error(`Checkpoint is ${bytes} bytes; the limit is ${CHECKPOINT_LIMIT_BYTES} bytes. Sections, largest first: ${sectionSizes(parsed)}. Curate the largest sections with checkpoint_replace, then try again. Nothing was changed.`);
    const stored = await writer.record({ type: "conversation.checkpoint.updated", version: 1, actor: "flywheel", payload: { conversationId, checkpoint: parsed } });
    if (!stored) throw new Error("The checkpoint writer is unavailable. Nothing was changed.");
    return parsed;
  };
  return {
    read,
    async replace(section, value) {
      const checkpoint = await read() ?? emptyConversationCheckpoint();
      return save(Schema.decodeUnknownSync(ConversationCheckpointSchema, { onExcessProperty: "error" })({ ...checkpoint, [section]: section === "designIntent" ? storedDesignIntent(value) : value }));
    },
    async decide(decision) {
      const checkpoint = await read() ?? emptyConversationCheckpoint();
      return save({ ...checkpoint, decisions: [...checkpoint.decisions, decision] });
    },
  };
}
