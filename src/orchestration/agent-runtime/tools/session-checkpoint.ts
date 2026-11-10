import { Schema } from "effect";
import { readJsonValue } from "../../../infra/llm/json-parse.js";
import { CheckpointDecisionSchema, ConversationCheckpointSchema } from "../../session/conversation-checkpoint-facts.js";
import { CHECKPOINT_SECTIONS, checkpointSectionInputSchema, renderConversationCheckpoint, type ConversationCheckpointOwner } from "../../session/conversation-checkpoint.js";
import { coerceToolInput, describeInputRepair } from "./coerce-input.js";
import type { ToolInputRepair } from "../llm/types.js";
import type { AdvertisedTool, RuntimeTool, RuntimeToolInput } from "./types.js";

export type CheckpointToolKind = "read" | "replace" | "decide";

/** The advertised form of one checkpoint tool. It names no checkpoint, so an
 *  agent without one advertises the same bytes as an agent that holds one. */
export function checkpointToolDefinition(kind: CheckpointToolKind): AdvertisedTool {
  return {
    name: `checkpoint_${kind}`,
    action: "ui_meta",
    description: kind === "read"
      ? "Read one section of your conversation's current typed checkpoint, or omit section for an overview. Working notes returns JSON pages of at most 4,000 Unicode characters; start at offset 0 and repeat with nextOffset until it is null. All earlier versions remain inspectable through recorded history."
      : kind === "replace"
        ? "Replace one section of your conversation's checkpoint. The complete checkpoint must fit 24,576 UTF-8 bytes; oversized writes are refused, never truncated. Read the section before replacing it."
        : "Add a dated decision to your conversation's checkpoint in the user's own words, naming the decision it replaces, or null when it replaces none. The complete checkpoint must fit 24,576 UTF-8 bytes.",
    promptSnippet: kind === "read" ? "Read the session checkpoint." : kind === "replace" ? "Replace one checkpoint section." : "Record a user's decision.",
    inputSchema: {
      type: "object",
      properties: kind === "read" ? {
        section: { type: "string", enum: [...CHECKPOINT_SECTIONS] },
        offset: { type: "integer", minimum: 0, description: "Zero-based Unicode character offset for workingNotes only. Defaults to 0. Continue with the returned nextOffset." },
      } : kind === "decide" ? {
        date: { type: "string", description: "Decision date, YYYY-MM-DD." },
        words: { type: "string", description: "The user's exact words." },
        replaces: { anyOf: [{ type: "string" }, { type: "null" }], description: "The earlier decision this replaces, or null." },
      } : {
        section: { type: "string", enum: [...CHECKPOINT_SECTIONS] },
        value: {
          description: "Replacement section. designIntent: {text, approved} or its text alone, saved as a draft unless approved is true; decisions: [{date, words, replaces}]; relevantSkills: [{id, reason}]; references: durable history entry ids; other sections: a string.",
          anyOf: [
            { type: "string" },
            { type: "object", properties: { text: { type: "string" }, approved: { type: "boolean", description: "True only after the person approved this design intent. Omitted means a draft." } }, required: ["text"], additionalProperties: false },
            { type: "array", items: { anyOf: [
              { type: "string" },
              { type: "object", properties: { id: { type: "string" }, reason: { type: "string" } }, required: ["id", "reason"], additionalProperties: false },
              { type: "object", properties: { date: { type: "string" }, words: { type: "string" }, replaces: { anyOf: [{ type: "string" }, { type: "null" }] } }, required: ["date", "words", "replaces"], additionalProperties: false },
            ] } },
          ],
        },
      },
      ...(kind === "read" ? {} : { required: kind === "decide" ? ["date", "words", "replaces"] : ["section", "value"] }),
      additionalProperties: false,
    },
    isConcurrencySafe: kind === "read",
  };
}

/** Creates one tool bound to the agent's own checkpoint. No input can select another conversation. */
export function createCheckpointTool(kind: CheckpointToolKind, owner: ConversationCheckpointOwner): RuntimeTool {
  return {
    ...checkpointToolDefinition(kind),
    ...(kind === "replace" ? { prepareAdmission: prepareSectionValue } : {}),
    async execute(input, context) {
      try {
        if (kind === "read") {
          const section = CHECKPOINT_SECTIONS.find((candidate) => candidate === input.section);
          if (input.section !== undefined && !section) return { content: `section must be one of: ${CHECKPOINT_SECTIONS.join(", ")}.`, outcome: "error" };
          const offset = input.offset ?? 0;
          if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) return { content: "offset must be a non-negative safe integer.", outcome: "error" };
          if (input.offset !== undefined && section !== "workingNotes") return { content: "offset is available only for section workingNotes.", outcome: "error" };
          const checkpoint = await owner.read();
          if (!checkpoint) return { content: "No checkpoint has been saved.", outcome: "ok" };
          if (section === "workingNotes") {
            const characters = Array.from(checkpoint.workingNotes);
            // JSON escaping costs at most six bytes per character, keeping a page below the 30,000-byte tool cap.
            const end = Math.min(offset + 4_000, characters.length);
            return { content: JSON.stringify({ content: characters.slice(offset, end).join(""), nextOffset: end < characters.length ? end : null }), outcome: "ok" };
          }
          if (section) return { content: JSON.stringify(checkpoint[section]), outcome: "ok" };
          // Every agent loop sets the agent check; only a context built without a request surface lacks it.
          if (!context.capabilities) throw new Error("the checkpoint renders only inside a request that carries the agent capability check");
          return { content: renderConversationCheckpoint(checkpoint, context.capabilities), outcome: "ok" };
        }
        if (kind === "decide") await owner.decide(Schema.decodeUnknownSync(CheckpointDecisionSchema, { onExcessProperty: "error" })(input));
        else {
          const section = CHECKPOINT_SECTIONS.find((candidate) => candidate === input.section);
          if (!section) return { content: `section must be one of: ${CHECKPOINT_SECTIONS.join(", ")}.`, outcome: "error" };
          await owner.replace(section, input.value);
        }
        return { content: "Checkpoint saved.", outcome: "ok" };
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), outcome: "error" };
      }
    },
  };
}

/** The section, not the tool's broad union, determines how a replacement is read. Strings valid in the stored
 *  shape stay as written, so JSON-looking working notes never change. A design intent sent as JSON text is read
 *  as its object, not saved as draft text. */
async function prepareSectionValue(input: Readonly<RuntimeToolInput>): Promise<{ readonly repair?: { readonly input: RuntimeToolInput; readonly notice: string } }> {
  const section = CHECKPOINT_SECTIONS.find((candidate) => candidate === input.section);
  if (!section) return {};
  const sectionSchema: Schema.Schema<unknown> = ConversationCheckpointSchema.fields[section];
  if (Schema.is(sectionSchema)(input.value)) return {};
  const repairs: ToolInputRepair[] = [];
  let value: unknown = input.value;
  if (typeof value === "string") {
    const parsed = readJsonValue(value)?.value;
    if (typeof parsed === "object" && parsed !== null) {
      value = parsed;
      repairs.push({ kind: "parsed_value", path: "value", type: Array.isArray(parsed) ? "array" : "object" });
    }
  }
  const schema = Schema.toJsonSchemaDocument(Schema.Struct({ value: sectionSchema })).schema;
  const repaired = coerceToolInput({ value }, schema, repair => repairs.push(repair));
  if (repairs.length === 0 || !Schema.is(checkpointSectionInputSchema(section))(repaired.value)) return {};
  return { repair: { input: { ...input, value: repaired.value }, notice: repairs.map(describeInputRepair).join("\n") } };
}
