import { Result, Schema, SchemaIssue } from "effect";
import { exactStruct } from "../../infra/exact-struct.js";

/** The closed field grammar of an output contract.
 *
 *  A definition author writes an output object in md frontmatter, beside an
 *  inline `brief:` of a workflow file, or in a shared `.json` contract file. The loader decodes it
 *  here with exact keys at every level, so a misspelled grammar key is a load
 *  error that names its key path, not a silently ignored option. */

const fieldTypes = ["string", "number", "boolean", "enum", "path", "list", "object", "variant"] as const;
export type FieldType = (typeof fieldTypes)[number];

const fieldKeyPattern = /^[a-z][a-z0-9_]*$/;

const FieldKeySchema = Schema.String.check(Schema.isPattern(fieldKeyPattern, {
  message: "expected a key that matches [a-z][a-z0-9_]*",
}));

const DescriptionSchema = Schema.String.check(Schema.makeFilter((text: string) => text.trim() !== "" || "expected a non-empty description"));

const CaseValueSchema = Schema.String.check(Schema.makeFilter((value: string) => value.trim() !== "" || "expected a non-empty case value"));

/** A record key that the decode reports when it fails its check. A record
 *  selects its keys by the encoded side of its key schema, so a checked key
 *  schema would silently drop a key that fails the check; a plain string
 *  selects every key, and decoding it to the checked key reports the failure. */
function reportedKey(key: Schema.String) {
  return Schema.String.pipe(Schema.decodeTo(key));
}

/** The members of a field that do not refer back to a field. */
const FieldLeafMembers = {
  type: Schema.Literals(fieldTypes),
  description: Schema.optionalKey(DescriptionSchema),
  example: Schema.optionalKey(Schema.Json),
  optional: Schema.optionalKey(Schema.Literal(true)),
  nullable: Schema.optionalKey(Schema.Literal(true)),
  values: Schema.optionalKey(Schema.Array(Schema.Union([Schema.String, Schema.Finite]))),
  exists: Schema.optionalKey(Schema.Literal(false)),
  min: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  max: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  unique: Schema.optionalKey(FieldKeySchema),
  tag: Schema.optionalKey(FieldKeySchema),
};

/** One declared value. `description` is optional on a keyed field, whose key
 *  is its meaning when it states none, and is not allowed on a list item
 *  (`of`), because an item has no key of its own. The interface derives from
 *  the schema members, so the two cannot drift. */
export interface Field extends Schema.Struct.Type<typeof FieldLeafMembers> {
  readonly of?: Field;
  readonly fields?: FieldMap;
  readonly cases?: CaseMap;
}

/** Keyed fields: an object's fields, a variant case, or a contract's fields. */
export type FieldMap = typeof FieldMapSchema.Type;

/** Variant cases: each tag value maps to one closed object of keyed fields. */
export interface CaseMap {
  readonly [value: string]: FieldMap;
}

/** Keys the envelope owns. A contract names them only through `summary` and
 *  `commands`, so they never appear among the declared fields. */
export const envelopeKeys = ["summary", "commands_run", "files_modified"] as const;

const envelopeKeyRemedy = {
  summary: "is an envelope key; describe it with the top-level \"summary\" key",
  commands_run: "is an envelope key; require citations with the top-level \"commands\" key",
  files_modified: "is an envelope key; every inline output already carries it",
} as const satisfies { readonly [Key in (typeof envelopeKeys)[number]]: string };

/** A struct of the grammar, which refuses every key the grammar does not
 *  declare. */
function closedStruct<const Fields extends Schema.Struct.Fields>(fields: Fields) {
  return exactStruct(Schema.Struct(fields).annotate({ messageUnexpectedKey: "is not a key of the output contract grammar" }));
}

/** Which grammar keys each field type admits beside the common keys, and
 *  which of them it requires. */
const typeKeys = {
  string: { admits: [], requires: [] },
  number: { admits: [], requires: [] },
  boolean: { admits: [], requires: [] },
  enum: { admits: ["values"], requires: ["values"] },
  path: { admits: ["exists"], requires: [] },
  list: { admits: ["of", "min", "max", "unique"], requires: ["of"] },
  object: { admits: ["fields"], requires: ["fields"] },
  variant: { admits: ["tag", "cases"], requires: ["tag", "cases"] },
} as const satisfies { readonly [Type in FieldType]: { readonly admits: readonly (keyof Field)[]; readonly requires: readonly (keyof Field)[] } };

const commonKeys = ["type", "description", "example", "optional", "nullable"] as const satisfies readonly (keyof Field)[];

interface GrammarIssue {
  readonly path: readonly PropertyKey[];
  readonly issue: string;
}

function isRequiredString(field: Field | undefined): boolean {
  return field?.type === "string" && field.optional === undefined && field.nullable === undefined;
}

/** `unique: <key>` needs every item to carry that key as a required string. */
function uniqueKeyIssue(item: Field, key: string): string | undefined {
  if (item.type === "object") {
    return isRequiredString(item.fields?.[key]) ? undefined : `each item must declare "${key}" as a required string`;
  }
  if (item.type === "variant") {
    const cases = Object.values(item.cases ?? {});
    return cases.every((caseFields) => isRequiredString(caseFields[key])) ? undefined : `each variant case must declare "${key}" as a required string`;
  }
  return "is allowed only on a list whose items are objects or variants";
}

function typeKeyIssues(field: Field): GrammarIssue[] {
  const keys = typeKeys[field.type];
  const admitted = new Set<string>([...commonKeys, ...keys.admits]);
  return [
    ...Object.keys(field).filter((key) => !admitted.has(key)).map((key) => ({ path: [key], issue: `is not allowed on a ${field.type} field` })),
    ...keys.requires.filter((key) => field[key] === undefined).map((key) => ({ path: [key], issue: `is required on a ${field.type} field` })),
  ];
}

/** The rules a single field node must satisfy, beyond the shape of its keys. */
function fieldIssues(field: Field, position: "keyed" | "item"): GrammarIssue[] {
  const issues = typeKeyIssues(field);
  if (position === "item") {
    if (field.description !== undefined) issues.push({ path: ["description"], issue: "is not allowed on a list item; describe the list instead" });
    if (field.optional !== undefined) issues.push({ path: ["optional"], issue: "is not allowed on a list item" });
  }
  if (field.values !== undefined) {
    if (field.values.length === 0) issues.push({ path: ["values"], issue: "expected one or more enum values" });
    if (new Set(field.values).size !== field.values.length) issues.push({ path: ["values"], issue: "enum values must be unique" });
  }
  if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
    issues.push({ path: ["max"], issue: `must not be less than min (${field.min})` });
  }
  if (field.unique !== undefined && field.of !== undefined) {
    const problem = uniqueKeyIssue(field.of, field.unique);
    if (problem) issues.push({ path: ["unique"], issue: problem });
  }
  if (field.type === "variant" && field.cases !== undefined) {
    if (Object.keys(field.cases).length === 0) issues.push({ path: ["cases"], issue: "expected one or more cases" });
    for (const [value, caseFields] of Object.entries(field.cases)) {
      if (field.tag !== undefined && Object.hasOwn(caseFields, field.tag)) {
        issues.push({ path: ["cases", value, field.tag], issue: "repeats the variant tag; the tag value names the case" });
      }
    }
  }
  return issues;
}

function fieldSchema(position: "keyed" | "item"): Schema.Codec<Field> {
  return closedStruct({
    ...FieldLeafMembers,
    of: Schema.optionalKey(Schema.suspend((): Schema.Codec<Field> => ItemFieldSchema)),
    fields: Schema.optionalKey(Schema.suspend((): Schema.Codec<FieldMap> => FieldMapSchema)),
    cases: Schema.optionalKey(Schema.Record(reportedKey(CaseValueSchema), Schema.suspend((): Schema.Codec<FieldMap> => FieldMapSchema))),
  }).check(
    Schema.makeFilter((field: Field) => {
      const issues = fieldIssues(field, position);
      return issues.length === 0 ? undefined : issues;
    }),
  );
}

const KeyedFieldSchema: Schema.Codec<Field> = fieldSchema("keyed");
const ItemFieldSchema: Schema.Codec<Field> = fieldSchema("item");
/** Keyed fields under the closed grammar. Control decodes the output
 *  contract that compilation pins on a map's group with it, so a pinned
 *  contract obeys the same grammar as an authored one. */
export const FieldMapSchema = Schema.Record(reportedKey(FieldKeySchema), KeyedFieldSchema);

/** The dotted key path of the first `commands_run` key in a field map. */
function nestedCommandsRun(fields: FieldMap): string | undefined {
  for (const [key, field] of Object.entries(fields)) {
    if (key === "commands_run") return key;
    const found = commandsRunBelow(field);
    if (found) return `${key}.${found}`;
  }
  return undefined;
}

/** The first `commands_run` key at any depth below one field: in its object
 *  fields, in each variant case, and in its list item, which can itself be a
 *  list. */
function commandsRunBelow(field: Field): string | undefined {
  for (const map of [field.fields, ...Object.values(field.cases ?? {})]) {
    const found = map ? nestedCommandsRun(map) : undefined;
    if (found) return found;
  }
  return field.of ? commandsRunBelow(field.of) : undefined;
}

const OutputObjectSchema = closedStruct({
  /** Description of the envelope `summary`. */
  summary: Schema.optionalKey(DescriptionSchema),
  /** The least number of cited command runs the agent must return. */
  commands: Schema.optionalKey(closedStruct({ min: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) })),
  /** The worker writes the payload as a JSON file in session scratch. */
  submit: Schema.optionalKey(Schema.Literal("file")),
  fields: Schema.optionalKey(FieldMapSchema),
}).check(Schema.makeFilter((output) => {
  const issues: GrammarIssue[] = [];
  for (const key of envelopeKeys) {
    if (output.fields && Object.hasOwn(output.fields, key)) issues.push({ path: ["fields", key], issue: envelopeKeyRemedy[key] });
  }
  // commands_run has one location, the top level, so the citation check has one path.
  const nested = output.fields ? nestedCommandsRun(output.fields) : undefined;
  if (nested && nested !== "commands_run") issues.push({ path: ["fields", ...nested.split(".")], issue: "commands_run exists only at the top level of the envelope" });
  if (output.submit === "file" && output.commands !== undefined) {
    issues.push({ path: ["commands"], issue: "is not allowed with submit: file; a file payload carries no command citations" });
  }
  return issues.length === 0 ? undefined : issues;
}));

/** An authored output contract after the grammar accepted it. */
export type OutputObject = typeof OutputObjectSchema.Type;

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

function issuePath(under: string | undefined, path: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined): string {
  const segments = (path ?? []).map((segment) => String(typeof segment === "object" ? segment.key : segment));
  if (under !== undefined) return [under, ...segments].join(".");
  return segments.length === 0 ? "(root)" : segments.join(".");
}

/** One line per issue of a failed decode, each led by its key path, for
 *  example `fields.hypothesis.type: Expected "string" | ...`. `under` names
 *  the decoded value and leads every path; without it a top-level issue is
 *  located at `(root)`. */
export function locatedIssues(issue: SchemaIssue.Issue, under?: string): readonly string[] {
  return formatIssues(issue).issues.map((entry) => `${issuePath(under, entry.path)}: ${entry.message}`);
}

/** Decode an authored output object. Each failure line names its key path. */
export function decodeOutputObject(input: unknown): Result.Result<OutputObject, readonly string[]> {
  const decoded = Schema.decodeUnknownResult(OutputObjectSchema, { errors: "all" })(input);
  if (Result.isSuccess(decoded)) return Result.succeed(decoded.success);
  return Result.fail(locatedIssues(decoded.failure.issue));
}

/** The output-only keys of the grammar. A workflow input has no envelope, no
 *  command citations, and no submission mode, so an input contract names
 *  only `fields`. */
const outputOnlyKeys = {
  summary: "is an output envelope key; a workflow input has no envelope",
  commands: "is an output key; a workflow input cites no commands",
  submit: "is an output key; a launch passes the workflow input directly",
} as const satisfies { readonly [Key in Exclude<keyof OutputObject, "fields">]-?: string };

/** Decode an authored workflow input contract. It is an output contract of
 *  the same closed field grammar that declares only `fields`, so one grammar
 *  and one compiler serve agent outputs and workflow inputs. Each failure line
 *  names its key path. */
export function decodeInputObject(input: unknown): Result.Result<OutputObject, readonly string[]> {
  const decoded = decodeOutputObject(input);
  if (Result.isFailure(decoded)) return decoded;
  const issues = Object.entries(outputOnlyKeys)
    .filter(([key]) => Object.hasOwn(decoded.success, key))
    .map(([key, issue]) => `${key}: ${issue}`);
  return issues.length === 0 ? decoded : Result.fail(issues);
}
