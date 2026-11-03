import { Array as Arr, Effect, Result, Schema, SchemaIssue } from "effect";
import { exactStruct } from "../../infra/exact-struct.js";
import { isRecord, type UnknownRecord } from "../../infra/record.js";
import { hashDefinition } from "../definition-hash.js";
import { envelope, modelFacingFields } from "./envelope.js";
import { checkCommandCitations, type ReadCommandEvidence } from "./evidence.js";
import { locatedIssues, type Field, type FieldMap, type FieldType, type OutputObject } from "./grammar.js";
import { renderOutputInstructions } from "./instructions.js";
import { probePath, type OutputIssue } from "./paths.js";
import type { PayloadOf, StepPayload, ValueOf } from "./types.js";

/** A JSON Schema document for contract-aware input conversion and validation. */
export interface JsonSchema {
  readonly [keyword: string]: unknown;
}

/** One declared top-level field as control validation reads it. */
export interface CompiledField {
  readonly key: string;
  readonly type: FieldType;
  readonly optional: boolean;
  readonly nullable: boolean;
  /** The declared item of a `list` field. */
  readonly of?: Field;
  /** The `unique` key of a `list` field. */
  readonly unique?: string;
  /** The `max` item count of a `list` field. */
  readonly max?: number;
  /** The declared values of an `enum` field. */
  readonly values?: readonly (string | number)[];
}

/** What `check` reads beyond the payload. */
export interface OutputCheckContext {
  readonly executionCwd: string;
  /** Whether a file or a directory exists at the path, through symlinks. */
  readonly pathExists: (absolutePath: string) => Promise<boolean>;
  /** Commands executed in this attempt conversation, from durable tool facts. */
  readonly readCommandEvidence?: ReadCommandEvidence;
}

export interface CompiledOutput<Payload = StepPayload> {
  readonly mode: "inline" | "file";
  /** Strict and pure: exact keys at every level. */
  readonly schema: Schema.Decoder<Payload>;
  /** The runtime handoff input schema, not the provider-facing tool schema. Its root is one `type: "object"`. */
  readonly toolInput: JsonSchema;
  readonly fields: readonly CompiledField[];
  /** The full postamble of a brief. */
  readonly instructions: string;
  /** Path existence probes and, in inline mode, the citation check. */
  readonly check: (payload: UnknownRecord, context: OutputCheckContext) => Promise<readonly OutputIssue[]>;
  /** The contract in canonical form, descriptions included. Definition
   *  provenance records it, so a reader of the store sees the contract a run
   *  used without a build of Flywheel. */
  readonly canonical: UnknownRecord;
  /** Hash of {@link canonical}. */
  readonly sha256: string;
  /** Hash of the canonical contract without descriptions and examples. Two
   *  contracts with this hash accept the same payloads. */
  readonly schemaSha256: string;
}

/** The words that a strict decode uses to report a key the contract does
 *  not declare. An agent output and a workflow input share the field schemas,
 *  so each names its own contract and its own remedy. */
interface ContractWords {
  /** The message of an undeclared key below the top level. */
  readonly unexpectedKey: string;
  /** What the report of undeclared top-level keys tells the reader to do. */
  readonly unknownTopLevelRemedy: string;
}

const OUTPUT_WORDS: ContractWords = {
  unexpectedKey: "is not declared by the output contract",
  unknownTopLevelRemedy: "Put this content in summary.",
};

const INPUT_WORDS: ContractWords = {
  unexpectedKey: "is not declared by the input contract",
  unknownTopLevelRemedy: "The workflow input contract does not declare them.",
};

/** A declared object of the contract, which refuses every key it does not
 *  declare in the contract's own words. */
function contractObject(fields: FieldMap, words: ContractWords, extra: { readonly [key: string]: Schema.Codec<unknown> } = {}): Schema.Codec<unknown> {
  return exactStruct(Schema.Struct({ ...extra, ...memberSchemas(fields, words) }).annotate({ messageUnexpectedKey: words.unexpectedKey }));
}

const NonEmptyTextSchema = Schema.String.check(Schema.makeFilter((text: string) => text.trim() !== "" || "expected a non-empty string"));

function listChecks(field: Field) {
  const checks = [];
  if (field.min !== undefined) checks.push(Schema.isMinLength(field.min));
  if (field.max !== undefined) checks.push(Schema.isMaxLength(field.max));
  const { unique } = field;
  if (unique !== undefined) {
    checks.push(Schema.makeFilter((items: readonly unknown[]) => {
      const keys = items.map((item) => (isRecord(item) ? item[unique] : undefined));
      return new Set(keys).size === keys.length || `each item must have a different "${unique}"`;
    }));
  }
  return checks;
}

function baseSchema(field: Field, words: ContractWords): Schema.Codec<unknown> {
  switch (field.type) {
    case "string": return NonEmptyTextSchema;
    case "number": return Schema.Finite;
    case "boolean": return Schema.Boolean;
    case "path": return NonEmptyTextSchema;
    case "enum": return Schema.Literals(field.values ?? []);
    case "list": {
      const list = Schema.Array(field.of ? valueSchema(field.of, words) : Schema.Unknown);
      const [first, ...rest] = listChecks(field);
      return first ? list.check(first, ...rest) : list;
    }
    case "object": return contractObject(field.fields ?? {}, words);
    case "variant": return variantSchema(field.tag ?? "", field.cases ?? {}, words);
  }
}

function variantSchema(tag: string, cases: { readonly [value: string]: FieldMap }, words: ContractWords): Schema.Codec<unknown> {
  const members = Object.entries(cases).map(([value, fields]) => contractObject(fields, words, { [tag]: Schema.Literal(value) }));
  return Schema.Union(members).annotate({ message: `expected "${tag}" to be one of: ${Object.keys(cases).join(", ")}` });
}

function valueSchema(field: Field, words: ContractWords): Schema.Codec<unknown> {
  const base = baseSchema(field, words);
  return field.nullable ? Schema.NullOr(base) : base;
}

/** The decoder of one declared field. A reader that reads one key of a
 *  stored payload of any contract decodes that key with it and ignores the
 *  other keys. */
export function fieldSchema<const F extends Field>(field: F): Schema.Decoder<ValueOf<F>> {
  // SAFETY: valueSchema and ValueOf read the same field, and tests/unit/workflows/output-contract/types.test.ts pins the decoded type to ValueOf.
  return valueSchema(field, OUTPUT_WORDS) as Schema.Decoder<ValueOf<F>>; // oxlint-disable-line typescript/consistent-type-assertions -- boundary: the decoder is built from the same field that ValueOf reads, and the grammar tests pin the two together.
}

function memberSchemas(fields: FieldMap, words: ContractWords) {
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => {
    const value = valueSchema(field, words);
    return [key, field.optional ? Schema.optionalKey(value) : value] as const;
  }));
}

/** The keys a payload carries in this mode, envelope keys first. A contract's
 *  `commands.min` makes `commands_run` a required list of at least that many
 *  records, so the postamble and the tool schema state the count. */
function payloadFields(output: OutputObject): FieldMap {
  const summary = { ...envelope.summary, ...(output.summary ? { description: output.summary } : {}) };
  if (output.submit === "file") return { summary, ...output.fields };
  const { optional: _optional, ...requiredCommandsRun } = envelope.commands_run;
  const commandsRun: Field = output.commands ? { ...requiredCommandsRun, min: output.commands.min } : envelope.commands_run;
  return { summary, commands_run: commandsRun, files_modified: envelope.files_modified, ...output.fields };
}

/** The fields the strict schema decodes. The citation check owns the
 *  `commands_run` count, because its report names the calls that the worker
 *  can cite, so the strict schema leaves the count out and one report states
 *  it once. */
function strictFields(fields: FieldMap): FieldMap {
  if (!fields.commands_run) return fields;
  const { min: _min, ...uncounted } = fields.commands_run;
  return { ...fields, commands_run: uncounted };
}

/** The payload object. Its undeclared keys are reported in one issue that
 *  names them all and states the remedy, in the same report as every other
 *  problem of the payload. */
function topLevelSchema(fields: FieldMap, words: ContractWords): Schema.Decoder<unknown> {
  return contractObject(fields, words).pipe(Schema.middlewareDecoding((decoded) =>
    Effect.mapError(decoded, (issue) => withUnknownTopLevelFields(issue, words))));
}

function withUnknownTopLevelFields(issue: SchemaIssue.Issue, words: ContractWords): SchemaIssue.Issue {
  if (issue._tag !== "Composite") return issue;
  const unknown: string[] = [];
  const kept: SchemaIssue.Issue[] = [];
  for (const entry of issue.issues) {
    // exactStruct reports an undeclared key through its rest signature, so the
    // key's issue is the encoding issue of that signature's value.
    const keyIssue = entry._tag === "Pointer" && entry.issue._tag === "Encoding" ? entry.issue.issue : undefined;
    if (entry._tag === "Pointer" && keyIssue?._tag === "UnexpectedKey") unknown.push(String(entry.path[0]));
    else kept.push(entry);
  }
  if (unknown.length === 0) return issue;
  const report = new SchemaIssue.InvalidValue({ message: `unknown top-level fields: ${unknown.join(", ")}. ${words.unknownTopLevelRemedy}` });
  return new SchemaIssue.Composite(issue.ast, Arr.append(kept, report));
}

function withNull(schema: JsonSchema): JsonSchema {
  if (Array.isArray(schema.enum)) return { ...schema, enum: [...schema.enum, null], ...(schema.type ? { type: [schema.type, "null"] } : {}) };
  if (typeof schema.type === "string") return { ...schema, type: [schema.type, "null"] };
  return { anyOf: [schema, { type: "null" }] };
}

function enumJsonSchema(values: readonly (string | number)[]): JsonSchema {
  if (values.every((value) => typeof value === "string")) return { type: "string", enum: values };
  if (values.every((value) => typeof value === "number")) return { type: "number", enum: values };
  return { enum: values };
}

function baseJsonSchema(field: Field): JsonSchema {
  switch (field.type) {
    case "string":
    case "path": return { type: "string" };
    case "number": return { type: "number" };
    case "boolean": return { type: "boolean" };
    case "enum": return enumJsonSchema(field.values ?? []);
    case "list": return {
      type: "array",
      items: field.of ? jsonSchemaFor(field.of) : {},
      ...(field.min === undefined ? {} : { minItems: field.min }),
      ...(field.max === undefined ? {} : { maxItems: field.max }),
    };
    case "object": return objectJsonSchema(field.fields ?? {});
    case "variant": return variantJsonSchema(field.tag ?? "", field.cases ?? {});
  }
}

function jsonSchemaFor(field: Field): JsonSchema {
  const schema = field.nullable ? withNull(baseJsonSchema(field)) : baseJsonSchema(field);
  // Examples render in the postamble only. Provider schema dialects differ on
  // the `examples` keyword, and the tool schema carries no keyword it needs.
  return field.description ? { ...schema, description: field.description } : schema;
}

function objectJsonSchema(fields: FieldMap, required = Object.keys(fields).filter((key) => !fields[key]?.optional)): JsonSchema {
  return {
    type: "object",
    properties: Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, jsonSchemaFor(field)])),
    required,
    additionalProperties: false,
  };
}

function variantJsonSchema(tag: string, cases: { readonly [value: string]: FieldMap }): JsonSchema {
  return {
    oneOf: Object.entries(cases).map(([value, fields]) => ({
      type: "object",
      properties: {
        [tag]: { type: "string", const: value, description: `Selects the ${value} case.` },
        ...Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, jsonSchemaFor(field)])),
      },
      required: [tag, ...Object.keys(fields).filter((key) => !fields[key]?.optional)],
      additionalProperties: false,
    })),
  };
}

/** The fields of one field map as control validation reads them. */
export function compiledFields(fields: FieldMap): CompiledField[] {
  return Object.entries(fields).map(([key, field]) => ({
    key,
    type: field.type,
    optional: field.optional === true,
    nullable: field.nullable === true,
    ...(field.of ? { of: field.of } : {}),
    ...(field.unique ? { unique: field.unique } : {}),
    ...(field.max === undefined ? {} : { max: field.max }),
    ...(field.values === undefined ? {} : { values: field.values }),
  }));
}

interface LocatedPath {
  readonly path: string;
  readonly value: string;
}

/** Every `path` value in a payload whose field asks for an existence probe.
 *  The walk follows the declared shape and skips values of the wrong shape,
 *  which the strict schema reports. */
function collectPaths(field: Field, value: unknown, at: string, found: LocatedPath[]): void {
  if (value === null || value === undefined) return;
  if (field.type === "path" && typeof value === "string" && field.exists !== false) found.push({ path: at, value });
  if (field.type === "list" && field.of && Array.isArray(value)) {
    const item = field.of;
    for (const [index, entry] of value.entries()) collectPaths(item, entry, `${at}.${index}`, found);
  }
  if (field.type === "object" && field.fields && isRecord(value)) collectMapPaths(field.fields, value, at, found);
  if (field.type === "variant" && field.tag && isRecord(value)) {
    const tagValue = value[field.tag];
    const caseFields = typeof tagValue === "string" ? field.cases?.[tagValue] : undefined;
    if (caseFields) collectMapPaths(caseFields, value, at, found);
  }
}

function collectMapPaths(fields: FieldMap, value: UnknownRecord, at: string, found: LocatedPath[]): void {
  for (const [key, field] of Object.entries(fields)) collectPaths(field, value[key], at === "" ? key : `${at}.${key}`, found);
}

/** The contract in canonical form. Without descriptions it states only what
 *  a payload must look like, which is what `schemaSha256` identifies. */
function canonicalOutput(output: OutputObject, withText: boolean): UnknownRecord {
  const canonicalField = (field: Field): UnknownRecord => {
    const { description, example, of, fields, cases, ...rest } = field;
    return {
      ...rest,
      ...(withText ? { description, example } : {}),
      ...(of ? { of: canonicalField(of) } : {}),
      ...(fields ? { fields: canonicalMap(fields) } : {}),
      ...(cases ? { cases: Object.fromEntries(Object.entries(cases).map(([value, map]) => [value, canonicalMap(map)])) } : {}),
    };
  };
  const canonicalMap = (map: FieldMap): UnknownRecord =>
    Object.fromEntries(Object.entries(map).map(([key, field]) => [key, canonicalField(field)]));
  return {
    ...(withText ? { summary: output.summary } : {}),
    commands: output.commands,
    submit: output.submit,
    fields: canonicalMap(output.fields ?? {}),
  };
}

const fileToolInput: JsonSchema = {
  type: "object",
  description: "Submit your output by the path of the JSON file that holds it.",
  properties: {
    path: { type: "string", description: "Absolute path of the JSON file inside your scratchpad directory that holds the complete output object." },
  },
  required: ["path"],
  additionalProperties: false,
};

/** The tool input of an inline output. `fields` is the model-facing view, so
 *  a cited run asks only for what the model knows. */
function inlineToolInput(fields: FieldMap): JsonSchema {
  return { ...objectJsonSchema(fields), description: "Your output JSON object. Pass every field directly as a top-level key." };
}

/** Compile one decoded output contract. An absent contract is `{}`: the agent
 *  returns the envelope only. Compile once per contract and reuse the result. */
export function compileOutput<const Output extends OutputObject>(output: Output): CompiledOutput<PayloadOf<Output>> {
  const mode = output.submit === "file" ? "file" : "inline";
  const fields = payloadFields(output);
  const min = output.commands?.min ?? 0;
  const declared = output.fields ?? {};
  const modelFields = modelFacingFields(fields);
  const schema = topLevelSchema(strictFields(fields), OUTPUT_WORDS);
  const canonical = canonicalOutput(output, true);
  // SAFETY: topLevelSchema and PayloadOf read the same contract, and tests/unit/workflows/output-contract/types.test.ts pins the decoded type to PayloadOf.
  const payloadSchema = schema as Schema.Decoder<PayloadOf<Output>>; // oxlint-disable-line typescript/consistent-type-assertions -- boundary: the schema is built from the same contract that PayloadOf reads, and the grammar tests pin the two together.
  return {
    mode,
    schema: payloadSchema,
    toolInput: mode === "file" ? fileToolInput : inlineToolInput(modelFields),
    fields: compiledFields(declared),
    instructions: renderOutputInstructions(output, modelFields),
    async check(payload, context) {
      const paths: LocatedPath[] = [];
      collectMapPaths(fields, payload, "", paths);
      const pathIssues = await Promise.all(paths.map((located) => probePath(context.executionCwd, context.pathExists, located)));
      const citationIssues = mode === "inline" ? await checkCommandCitations(payload, min, context.readCommandEvidence) : [];
      return [...pathIssues.filter((entry) => entry !== undefined), ...citationIssues];
    },
    canonical,
    sha256: hashDefinition(canonical).sha256,
    schemaSha256: hashDefinition(canonicalOutput(output, false)).sha256,
  };
}

/** A workflow input value after its contract decoded it: one JSON object. */
export const WorkflowInputValueSchema = Schema.Record(Schema.String, Schema.Json);
export type WorkflowInputValue = typeof WorkflowInputValueSchema.Type;

/** A compiled workflow input contract (refer to `decodeInputObject`). It
 *  declares fields only: a launch passes the decoded object as it is, with no
 *  envelope. */
export interface CompiledInput {
  /** Strict and pure: exact keys at every level. */
  readonly schema: Schema.Decoder<unknown>;
  /** The declared top-level fields. A phase `over: input.<field>` reads its
   *  list here, as a phase over a list in the output of another phase reads
   *  that output's fields. */
  readonly fields: readonly CompiledField[];
  /** The JSON Schema of the input object, which the `workflow` tool states
   *  for the workflow. Its root is one `type: "object"`. */
  readonly jsonSchema: JsonSchema;
  /** Hash of the canonical contract without descriptions and examples. Two
   *  contracts with this hash accept the same input. Definition identity
   *  pins it, so a changed contract is drift and a description edit is not. */
  readonly schemaSha256: string;
}

/** Compile one decoded workflow input contract with the field schemas of the
 *  agent output compiler, without the output envelope. */
export function compileInput(input: OutputObject): CompiledInput {
  const fields = input.fields ?? {};
  return {
    schema: topLevelSchema(fields, INPUT_WORDS),
    fields: compiledFields(fields),
    jsonSchema: objectJsonSchema(fields),
    schemaSha256: hashDefinition(canonicalOutput(input, false)).sha256,
  };
}

/** Decode launch data against a compiled input contract. Each failure line
 *  names its key path under `input`, for example
 *  `input.targets.2.id: Missing key`. */
export function decodeWorkflowInput(contract: CompiledInput, value: unknown): Result.Result<WorkflowInputValue, readonly string[]> {
  const decoded = Schema.decodeUnknownResult(contract.schema, { errors: "all" })(value);
  if (Result.isFailure(decoded)) return Result.fail(locatedIssues(decoded.failure.issue, "input"));
  // The strict schema admits only declared JSON values, so this decode only
  // states the JSON type of the value it accepted.
  const json = Schema.decodeUnknownResult(WorkflowInputValueSchema)(decoded.success);
  return Result.isSuccess(json) ? Result.succeed(json.success) : Result.fail(["input: expected one JSON object"]);
}
