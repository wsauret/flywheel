import { errorMessage } from "../../../infra/error-message.js";
import { collapsedMarkup, splitCollapsedValue, type CollapsedValue } from "../../../infra/handoff-normalize.js";
import { Log } from "../../../infra/log.js";
import { describeCommandRunRepair, type CommandRunRepair, type ReadCommandEvidence } from "../../../workflows/output-contract/evidence.js";
import type { HandoffToolSchema } from "../../workflow-host/handoff-tool-schema.js";
import type { ToolOutcome } from "../../../infra/tool-outcome.js";
import { coerceToolInput } from "./coerce-input.js";

interface HandoffContent {
  [key: string]: unknown;
}

interface EngineHandoffContext {
  executionCwd: string;
  /** The agent's scratchpad, the only place a `submit: file` output may be. */
  scratchDir?: string;
  /** Aborted when the call was cut off, such as by the dispatcher's watchdog,
   *  whose relabel makes the result an error whatever the tool returns. */
  signal?: AbortSignal;
  handoff?: {
    onContent: (content: HandoffContent) => void;
    readCommandEvidence?: ReadCommandEvidence;
  };
}

interface EngineHandoffResult {
  content: string;
  outcome: ToolOutcome;
  terminate?: boolean;
  details?: unknown;
}

interface InputRepair {
  input: HandoffContent;
  /** One line for each collapsed value, which leads the tool result. */
  notice: string;
}

interface EngineHandoffToolDefinition<Context extends EngineHandoffContext> {
  name: string;
  inputSchema?: HandoffContent;
  /** Splits a collapsed handoff back into top-level fields before execution. */
  prepareAdmission: (input: HandoffContent) => Promise<{ repair?: InputRepair }>;
  execute: (input: HandoffContent, context: Context) => Promise<EngineHandoffResult>;
}


interface CreateHandoffToolCoreOptions {
  schema?: HandoffToolSchema;
  logService: string;
  terminateOnSuccess?: boolean;
  noHandoffMessage: string;
  successMessage: string;
  failureMessage: (message: string) => string;
}

/**
 * Splits each collapsed value of a handoff back into the top-level fields it
 * holds (see `splitCollapsedValue`), or returns undefined when no value
 * collapsed or none could be split safely. Each body parses as the dispatcher
 * parses a top-level value of its field (`coerceToolInput`), so a list field
 * reads its JSON and a string field reads its text. A split merges only when
 * every recovered name is a field of the schema, every body parses to its
 * field's kind, and no recovered field states a top-level field differently.
 * An open schema admits an undeclared name only with a body that is JSON,
 * because nothing says which kind of value it takes. A value that does not
 * split stays for `detectCollapsedHandoff` to refuse.
 */
function recoverCollapsedHandoff(input: HandoffContent, inputSchema: HandoffContent): InputRepair | undefined {
  const recovered: HandoffContent = { ...input };
  const notices: string[] = [];
  for (const [key, text] of Object.entries(input)) {
    if (typeof text !== "string") continue;
    const split = splitCollapsedValue(key, text);
    const fields = split ? splitFields(key, split, recovered, inputSchema) : undefined;
    if (!split || !fields) continue;
    Object.assign(recovered, fields);
    const names = split.fragments.map((fragment) => `\`${fragment.name}\``);
    notices.push(names.length === 0
      ? `Note: the tool-call markup at the end of \`${key}\` was dropped.`
      : `Note: the tool-call markup in \`${key}\` was read as the separate arguments ${names.join(", ")}.`);
  }
  return notices.length === 0 ? undefined : { input: recovered, notice: notices.join("\n") };
}

/** The top-level fields one split value holds, or undefined when any part of it is ambiguous. */
function splitFields(key: string, split: CollapsedValue, given: HandoffContent, schema: HandoffContent): HandoffContent | undefined {
  const own = declaredProperty(schema, key) === undefined ? { value: split.value } : fieldValue(key, split.value, schema);
  if (!own) return undefined;
  const fields: HandoffContent = { [key]: own.value };
  for (const { name, body } of split.fragments) {
    const parsed = fieldValue(name, body, schema);
    if (!parsed || Object.hasOwn(fields, name)) return undefined;
    if (given[name] !== undefined && !Bun.deepEquals(given[name], parsed.value)) return undefined;
    fields[name] = parsed.value;
  }
  return fields;
}

function declaredProperty(schema: HandoffContent, name: string): HandoffContent | undefined {
  const properties = schema.properties;
  if (!isRecord(properties) || !Object.hasOwn(properties, name)) return undefined;
  const property = properties[name];
  return isRecord(property) ? property : undefined;
}

function fieldValue(name: string, body: string, schema: HandoffContent): { value: unknown } | undefined {
  const property = declaredProperty(schema, name);
  if (property === undefined) return schema.additionalProperties === false ? undefined : jsonValue(body);
  const value = coerceToolInput({ [name]: body }, schema)[name];
  return typeof value !== "string" || acceptsText(property) ? { value } : undefined;
}

/** A field whose schema states no type, or a type that admits a string, takes text as written. */
function acceptsText(property: HandoffContent): boolean {
  const type = property.type;
  return type === undefined || type === "string" || (Array.isArray(type) && type.includes("string"));
}

function jsonValue(body: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(body) };
  } catch {
    return undefined;
  }
}

/**
 * Detects the "collapsed handoff" failure that recovery could not repair:
 * instead of passing each field as a top-level argument, the model serialized
 * the handoff as pseudo-XML text inside one string field (e.g. `summary`), with
 * leaked tool-call tags between the arguments. The schema would then reject it
 * with a misleading length error, sending the agent into a retry loop trimming
 * prose that was never the problem, so the structural signal gets an
 * actionable message instead. A tag quoted in prose is not that signal.
 */
function detectCollapsedHandoff(input: HandoffContent): { field: string; marker: string } | null {
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") continue;
    const marker = collapsedMarkup(key, value);
    if (marker) return { field: key, marker };
  }
  return null;
}

function isRecord<Value>(value: Value): value is Value & HandoffContent {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOnce(read: ReadCommandEvidence): ReadCommandEvidence {
  let evidence: ReturnType<ReadCommandEvidence> | undefined;
  return () => (evidence ??= read());
}

/** The other top-level keys the agent's tool input declares, so a repair
 *  message names the keys this agent actually takes. */
function siblingKeys(schema: HandoffToolSchema | undefined, field: string): string[] {
  const properties = schema?.input.properties;
  return isRecord(properties) ? Object.keys(properties).filter((key) => key !== field) : [];
}

/** One record per handoff whose citations were repaired: the count of each
 *  repair kind and whether the handoff was accepted, with no content. */
function logCitationRepairs(log: Pick<ReturnType<typeof Log.create>, "info">, repairs: readonly CommandRunRepair[], accepted: boolean): void {
  if (repairs.length === 0) return;
  const count = (kind: CommandRunRepair["kind"]) => repairs.filter((repair) => repair.kind === kind).length;
  log.info("handoff citations repaired", {
    ignoredFields: count("ignored_field"),
    repeatedCitations: count("repeated_citation"),
    droppedCitations: count("dropped_citation"),
    accepted,
  });
}

function missingRequiredFields(input: HandoffContent, schema: HandoffToolSchema | undefined): string[] {
  const required = schema?.input.required;
  return (Array.isArray(required) ? required : []).filter((key): key is string => typeof key === "string" && !(key in input));
}

export function createHandoffToolCore<Context extends EngineHandoffContext>(
  options: CreateHandoffToolCoreOptions,
): EngineHandoffToolDefinition<Context> {
  const log = Log.create({ service: options.logService });
  const schema = options.schema;

  return {
    name: "handoff",
    ...(schema ? { inputSchema: schema.input } : {}),
    async prepareAdmission(input) {
      // A handoff with no output contract takes any key, so its schema is open.
      const repair = recoverCollapsedHandoff(input, schema?.input ?? {});
      if (!repair) return {};
      log.info("collapsed handoff split", { fields: Object.keys(repair.input).filter((key) => repair.input[key] !== input[key]) });
      return { repair };
    },
    async execute(input: HandoffContent, context: Context): Promise<EngineHandoffResult> {
      if (!context.handoff) {
        return { content: options.noHandoffMessage, outcome: "error" };
      }
      const handoff = context.handoff;

      // prepareAdmission already split every collapsed value it could, so a
      // collapsed value here is one the split found ambiguous.
      const collapsed = detectCollapsedHandoff(input);
      if (collapsed) {
        const siblings = siblingKeys(schema, collapsed.field);
        const correctExample = [`"${collapsed.field}": "...prose with no tags..."`, ...siblings.slice(0, 2).map((key) => `"${key}": ...`)].join(", ");
        return {
          content:
            `Your \`${collapsed.field}\` value contains an embedded tag (\`${collapsed.marker}\`), which means the entire handoff collapsed into a single argument. ` +
            "STOP emitting XML or tool-call markup inside argument values. The handoff tool takes one flat JSON object; each field is its own top-level key. " +
            `WRONG (what you just sent): {"${collapsed.field}": "...prose...${collapsed.marker}<parameter name=\\"...\\">..."}. ` +
            `RIGHT: {${correctExample}}. ` +
            `On your next call: emit one JSON object, pass \`${collapsed.field}\` as plain prose with no tags, and pass every other field${siblings.length === 0 ? "" : ` (${siblings.join(", ")})`} as sibling top-level keys; never write \`<...>\`, \`</...>\`, \`<parameter>\`, or \`</invoke>\` in any value.`,
          outcome: "error",
        };
      }

      const missingRequired = missingRequiredFields(input, schema);
      if (missingRequired.length > 0) {
        return {
          content:
            `Handoff is missing required top-level fields: ${missingRequired.join(", ")}. ` +
            "Call handoff again with those fields as direct arguments; do not nest them inside task_content, content, json, or payload.",
          outcome: "error",
        };
      }

      let payload: HandoffContent = input;
      let notes: readonly string[] = [];
      if (schema?.accept) {
        // Recorded commands fill the submission and then check its
        // citations; both read the same ledger, so one call reads it once.
        const readCommandEvidence = handoff.readCommandEvidence ? readOnce(handoff.readCommandEvidence) : undefined;
        const accepted = await schema.accept(input, {
          executionCwd: context.executionCwd,
          ...(context.scratchDir ? { scratchDir: context.scratchDir } : {}),
          ...(readCommandEvidence ? { readCommandEvidence } : {}),
        });
        logCitationRepairs(log, accepted.repairs, accepted.ok);
        // The notes lead the result as the dispatcher's input-repair notes do,
        // so the model learns how its citations were read either way.
        notes = accepted.repairs.map(describeCommandRunRepair);
        if (!accepted.ok) {
          return {
            content: [
              ...notes,
              "Handoff rejected; nothing was written. Fix every problem below, then call handoff again.",
              ...accepted.issues.map((problem) => `- ${problem}`),
              accepted.recovery,
            ].join("\n"),
            outcome: "error",
          };
        }
        payload = accepted.payload;
      }
      // A payload is captured only with an ok result: a captured handoff
      // under an error result would leave the run neither ended nor corrected.
      if (context.signal?.aborted) {
        return { content: [...notes, "Handoff was cut off before it finished; nothing was recorded. Call handoff again."].join("\n"), outcome: "error" };
      }

      try {
        handoff.onContent(payload);
        log.debug("handoff captured");
        return {
          content: [...notes, options.successMessage].join("\n"),
          outcome: "ok",
          ...(options.terminateOnSuccess ? { terminate: true } : {}),
        };
      } catch (err) {
        const message = errorMessage(err);
        log.error("failed to record handoff", { error: message });
        return { content: options.failureMessage(message), outcome: "error" };
      }
    },
  };
}
