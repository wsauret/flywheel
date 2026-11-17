import type { Schema } from "effect";
import { envelopeKeys, type Field, type FieldMap, type OutputObject } from "./grammar.js";

/** The postamble of a brief: the universal rules, then the
 *  envelope, then the declared fields with an example, then the rules that the
 *  declared types imply. */

/** Rules that hold for every agent: how to call the tool, shape the JSON, and
 *  carry a person's mid-run revision forward. A parent's message reaches later
 *  agents as a request addendum; a person's direct message reaches them only
 *  through this output. */
const universalRules: readonly string[] = [
  "Send every REQUIRED field, an optional field only when it adds results or evidence, and no unlisted field.",
  "When a message from the person, or one addressed to you or your item, changed your work, record each change in the handoff: quote the instruction and name what it replaced. Later agents read your handoff, not your conversation.",
  "Before the handoff, print a 2-5 sentence summary of what you did, key decisions, and what the user should know. The handoff call is your last action; nothing after it is seen.",
  "Send plain JSON: no comments, no markdown wrapping, and no other field serialized as XML, a code fence, or tool-call markup such as `<parameter>` inside a string value. A tag quoted in prose is allowed.",
];

const pathRule = "Each `path` value uses this machine's path syntax and can be absolute or relative to your working directory. Preserve the exact path of the artifact, including scratch files outside that directory. The path can name a file or a directory, and it must exist when you call `handoff`, unless its field says that it can name a file that does not exist yet.";

const fileProcedure = "Write the complete output object as one JSON file named `output.json` directly inside your scratchpad directory, whose absolute path the Scratchpad Directory section of your instructions gives, and repair that file in place when the runtime reports a problem. Write it there even when your brief names another location; the runtime accepts no other place. Then call `handoff` with only `{\"path\": \"<absolute path of that file>\"}`. The runtime reads the file, checks it strictly, and reports each problem with its line. Do not put the output in the `handoff` call itself.";

function typeLabel(field: Field): string {
  switch (field.type) {
    case "enum": return `one of ${(field.values ?? []).map((value) => JSON.stringify(value)).join(", ")}`;
    case "list": return `list of ${field.of ? typeLabel(field.of) : "values"}`;
    case "variant": return `variant on \`${field.tag ?? ""}\``;
    case "path": return field.exists === false ? "path, may not exist yet" : "path";
    default: return field.type;
  }
}

function qualifiers(field: Field, keyed: boolean): string {
  const parts = [
    ...(keyed ? [field.optional ? "optional" : "REQUIRED"] : []),
    typeLabel(field),
    ...(field.nullable ? ["nullable"] : []),
    ...(field.min === undefined ? [] : [`at least ${field.min}`]),
    ...(field.max === undefined ? [] : [`at most ${field.max}`]),
    ...(field.unique === undefined ? [] : [`each item has a different \`${field.unique}\``]),
  ];
  return parts.join(", ");
}

/** The nested lines that describe an object's fields, a variant's cases, or a
 *  list item's shape, indented under the owning bullet. */
function nestedLines(field: Field, indent: string, shown: ReadonlySet<Field>): string[] {
  if (field.type === "list" && field.of) {
    const nested = nestedLines(field.of, `${indent}  `, shown);
    return nested.length === 0 ? [] : [`${indent}- Each item (${typeLabel(field.of)}):`, ...nested];
  }
  if (field.type === "object" && field.fields) return fieldLines(field.fields, indent, shown);
  if (field.type === "variant" && field.cases) {
    return Object.entries(field.cases).flatMap(([value, fields]) => [
      `${indent}- When \`${field.tag ?? ""}\` is ${JSON.stringify(value)}:`,
      ...fieldLines(fields, `${indent}  `, shown),
    ]);
  }
  return [];
}

/** A field without a description means what its key says, so its line ends
 *  after its qualifiers. A field's authored example appears on its line only
 *  when the full example leaves it out (`shown` holds the fields whose example
 *  the full example uses), such as a field of a variant case after the first,
 *  or a field under an enclosing field with its own example. */
function fieldLines(fields: FieldMap, indent: string, shown: ReadonlySet<Field>): string[] {
  return Object.entries(fields).flatMap(([key, field]) => [
    `${indent}- **${key}** (${qualifiers(field, true)})${field.description === undefined ? "" : `: ${field.description}`}`,
    ...(field.example === undefined || shown.has(field) ? [] : [`${indent}  Example: ${JSON.stringify(field.example)}`]),
    ...nestedLines(field, `${indent}  `, shown),
  ]);
}

function exampleValue(field: Field, shown: Set<Field>): Schema.Json {
  if (field.example !== undefined) {
    shown.add(field);
    return field.example;
  }
  switch (field.type) {
    case "string": return "...";
    case "number": return 1;
    case "boolean": return true;
    case "path": return "path/to/file";
    case "enum": return field.values?.[0] ?? "...";
    case "list": return field.of ? [exampleValue(field.of, shown)] : [];
    case "object": return examplesOf(field.fields ?? {}, shown);
    case "variant": {
      const [value, fields] = Object.entries(field.cases ?? {})[0] ?? ["...", {}];
      return { [field.tag ?? "tag"]: value, ...examplesOf(fields, shown) };
    }
  }
}

function examplesOf(fields: FieldMap, shown: Set<Field>): { readonly [key: string]: Schema.Json } {
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, exampleValue(field, shown)]));
}

/** An example value of each field: the field's own example, else the
 *  first value that its type allows. Equal fields give equal examples. */
export function exampleObject(fields: FieldMap): { readonly [key: string]: Schema.Json } {
  return examplesOf(fields, new Set());
}

function hasPathField(fields: FieldMap): boolean {
  const nestedHasPath = (field: Field): boolean =>
    field.type === "path"
    || (field.of !== undefined && nestedHasPath(field.of))
    || (field.fields !== undefined && hasPathField(field.fields))
    || Object.values(field.cases ?? {}).some(hasPathField);
  return Object.values(fields).some(nestedHasPath);
}

/** Render the postamble for one contract. `modelFields` are the keys the
 *  model fills in this mode: the envelope keys first, then the declared
 *  fields. Without `commandEvidence`, the agent has no shell whose calls it
 *  can cite (ARCH-CONTEXT-033), so the postamble leaves out `commands_run`.
 *  The one example shows every field, or, for a contract that declares none,
 *  the required fields and each optional field with an example of its own. */
export function renderOutputInstructions(output: OutputObject, modelFields: FieldMap, commandEvidence: boolean): string {
  const fileMode = output.submit === "file";
  const declared = output.fields ?? {};
  const payloadFields = commandEvidence ? modelFields : Object.fromEntries(Object.entries(modelFields).filter(([key]) => key !== "commands_run"));
  const envelopeFields = Object.fromEntries(Object.entries(payloadFields).filter(([key]) => envelopeKeys.some((name) => name === key)));
  const typeRules = [
    ...(hasPathField(declared) ? [pathRule] : []),
    ...(fileMode ? [fileProcedure] : []),
  ];
  const exampleFields = Object.keys(declared).length === 0
    ? Object.fromEntries(Object.entries(payloadFields).filter(([, field]) => !field.optional || field.example !== undefined))
    : payloadFields;
  const shown = new Set<Field>();
  const example = `\`\`\`json\n${JSON.stringify(examplesOf(exampleFields, shown), null, 2)}\n\`\`\``;
  const sections = [
    `---
## Handoff

To finish, you MUST call \`handoff\` with a JSON object of the fields below. Plain text is not completion. If the call is rejected, fix what it reports and call again.`,
    `### Rules\n\n${universalRules.map((rule, index) => `${index + 1}. ${rule}`).join("\n")}`,
    `### Envelope\n\n${fieldLines(envelopeFields, "", shown).join("\n")}`,
    ...(Object.keys(declared).length === 0 ? [] : [`### Fields\n\n${fieldLines(declared, "", shown).join("\n")}`]),
    `### Example\n\n${fileMode ? "Write this shape to the output file:\n\n" : ""}${example}`,
    ...(typeRules.length === 0 ? [] : [`### Type rules\n\n${typeRules.map((rule, index) => `${index + 1}. ${rule}`).join("\n")}`]),
  ];
  return sections.join("\n\n");
}
