import { Result, Schema } from "effect";
import * as SchemaAST from "effect/SchemaAST";
import { installedConfigSchema } from "./schema.js";
import { isPresentedSettingId, presentedSettingRow, settingDefinitions } from "./setting-definitions.js";
import { moduleSelectionFromConfig } from "../modules.js";

import { persistedDisabledModuleIds } from "../../protocol/module-ids.js";
type Ownership = "generated-writer" | "custom-writer" | "runtime-owned" | "retained-section";
type Definition = {
  readonly ownership?: Ownership;
  readonly owner?: string;
  readonly path?: readonly string[];
  readonly key?: string;
  readonly schema: Schema.Top;
  readonly id: string;
  readonly presentation: { readonly kind: string };
};

type ConfigValue = string | number | boolean | null | undefined | readonly ConfigValue[] | ConfigDictionary;
interface ConfigDictionary { [key: string]: ConfigValue }
type ConfigDefaultState =
  | { readonly kind: "decoded"; readonly value: ConfigValue }
  | { readonly kind: "unset" };

export interface ConfigReferenceEntry {
  readonly path: string;
  readonly schemaPath: string;
  readonly authoredSegments: readonly string[];
  readonly schemaSegments: readonly string[];
  readonly examplePath: string;
  readonly description: string;
  readonly ownership: Ownership;
  readonly concreteSegments: readonly string[];
  readonly authored: true;
  readonly type: string;
  readonly constraints?: ConfigDictionary;
  readonly openVocabulary?: string;
  readonly defaultState: ConfigDefaultState;
  readonly defaultValue?: ConfigValue;
  readonly sensitivity: "public" | "sensitive";
  readonly branch?: string;
  readonly exampleValue: ConfigValue;
  readonly example?: string;
  readonly snippet: string;
}

export interface ConfigReference {
  readonly entries: readonly ConfigReferenceEntry[];
  readonly example: string;
  readonly exampleModel: ConfigDictionary;
}

interface TraversalContext {
  readonly schemaPath: readonly string[];
  readonly authoredPath: readonly string[];
  readonly concretePath: readonly string[];
  readonly ownership: Ownership;
  readonly inheritedDescription?: string;
  readonly branch?: string;
  readonly exampleModel: (value: ConfigValue) => ConfigDictionary;
}

function quoteSegment(segment: string): string {
  return /^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment);
}

function displayPath(segments: readonly string[]): string {
  return segments.map(quoteSegment).join(".");
}

function valueAtPath(value: ConfigValue, path: readonly string[]): ConfigValue {
  let current = value;
  for (const segment of path) {
    if (!isDictionary(current)) return undefined;
    current = Object.getOwnPropertyDescriptor(current, segment)?.value;
  }
  return current;
}

function ownershipOf(definition: Definition): Ownership {
  return definition.ownership ?? "retained-section";
}

function definitionPath(definition: Definition): readonly string[] {
  return definition.path ?? (definition.key === undefined ? [] : [definition.key]);
}

function schemaRootPath(authoredPath: readonly string[]): readonly string[] {
  return authoredPath[0] === "disabled_modules" ? ["modules"] : authoredPath;
}


function exampleKey(ast: SchemaAST.AST): string {
  return SchemaAST.resolveAt<string>("exampleKey")(ast) ?? "example";
}

function isNever(ast: SchemaAST.AST): boolean {
  return SchemaAST.isNever(ast) || (SchemaAST.isUnion(ast) && ast.types.every(isNever));
}

function sample(ast: SchemaAST.AST, path: readonly string[]): ConfigValue {
  if (SchemaAST.isLiteral(ast)) return configValue(ast.literal);
  if (SchemaAST.isString(ast) || SchemaAST.isTemplateLiteral(ast)) return SchemaAST.resolveAt<string>("exampleValue")(ast) ?? "example";
  if (SchemaAST.isNumber(ast)) {
    const json = constraintOracle(ast);
    const minimum = numericConstraint(json, "minimum") ?? numericConstraint(json, "exclusiveMinimum");
    return minimum === undefined ? 1 : minimum;
  }
  if (SchemaAST.isBoolean(ast)) return true;
  if (SchemaAST.isNull(ast)) return null;
  if (SchemaAST.isArrays(ast)) return [];
  if (SchemaAST.isUnion(ast)) {
    const viable = ast.types.find((member) => !isNever(member));
    if (viable === undefined) throw new Error(`Never has no configuration example at ${displayPath(path)}`);
    return sample(viable, path);
  }
  if (SchemaAST.isObjects(ast)) {
    const object: ConfigDictionary = {};
    for (const property of ast.propertySignatures) {
      if (typeof property.name === "string" && !isNever(property.type)) object[property.name] = sample(property.type, [...path, property.name]);
    }
    for (const index of ast.indexSignatures) object[exampleKey(ast)] = sample(index.type, [...path, "*"]);
    return object;
  }
  if (SchemaAST.isUnknown(ast) || SchemaAST.isAny(ast)) return "value";
  throw new Error(`Unsupported configuration AST node ${ast._tag} at ${displayPath(path)}`);
}

function objectExample(ast: SchemaAST.Objects, key: string, value: ConfigValue): ConfigDictionary {
  const object: ConfigDictionary = {};
  for (const property of ast.propertySignatures) {
    if (typeof property.name === "string" && property.name !== key && property.type.context?.isOptional !== true && !isNever(property.type)) {
      object[property.name] = sample(property.type, [property.name]);
    }
  }
  object[key] = value;
  return object;
}

function renameExampleKey(model: ConfigDictionary, path: readonly string[], replacement: string): ConfigDictionary {
  if (path.length === 1) return { [replacement]: Object.values(model)[0] };
  const key = path[0];
  if (key === undefined) return model;
  const child = model[key];
  if (!isDictionary(child)) return model;
  return { ...model, [key]: renameExampleKey(child, path.slice(1), replacement) };
}

function modelAtPath(path: readonly string[], value: ConfigValue): ConfigDictionary {
  const [segment, ...rest] = path;
  if (segment === undefined) return {};
  return { [segment]: rest.length === 0 ? value : modelAtPath(rest, value) };
}

function withoutPath(model: ConfigDictionary, path: readonly string[]): ConfigDictionary {
  const [segment, ...rest] = path;
  if (segment === undefined) return model;
  const copy = { ...model };
  if (rest.length === 0) return Object.fromEntries(Object.entries(copy).filter(([key]) => key !== segment));
  const child = copy[segment];
  if (isDictionary(child)) copy[segment] = withoutPath(child, rest);
  return copy;
}
function numericConstraint(value: ConfigDictionary, key: string): number | undefined {
  const direct = value[key];
  if (typeof direct === "number") return direct;
  const allOf = value.allOf;
  if (!Array.isArray(allOf)) return undefined;
  for (const member of allOf) if (isDictionary(member) && typeof member[key] === "number") return member[key];
  return undefined;
}

const CONSTRAINT_KEYS = new Set(["type", "enum", "anyOf", "oneOf", "allOf", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern", "items", "properties", "additionalProperties", "required", "description"]);

function constraintOracle(ast: SchemaAST.AST): ConfigDictionary {
  const schema = Schema.toJsonSchemaDocument(Schema.make(ast)).schema;
  if (!isDictionary(schema)) throw new Error(`JSON Schema oracle returned an invalid constraint for ${ast._tag}`);
  assertSupportedConstraint(schema);
  return schema;
}

function assertSupportedConstraint(value: unknown, propertyMap = false): void {
  if (Array.isArray(value)) {
    for (const item of value) assertSupportedConstraint(item);
    return;
  }
  if (!isDictionary(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (!propertyMap && !CONSTRAINT_KEYS.has(key)) throw new Error(`Unsupported fixed constraint: ${key}`);
    assertSupportedConstraint(child, key === "properties");
  }
}

function typeOf(ast: SchemaAST.AST): string {
  if (SchemaAST.isUnion(ast)) return [...new Set(ast.types.filter((member) => !isNever(member)).map(typeOf))].join(" | ");
  if (SchemaAST.isLiteral(ast)) return typeof ast.literal;
  if (SchemaAST.isArrays(ast)) return "array";
  if (SchemaAST.isObjects(ast)) return ast.indexSignatures.length > 0 ? "record" : "table";
  return ast._tag.toLowerCase();
}

function descriptionOf(ast: SchemaAST.AST, context: TraversalContext): string {
  const description = SchemaAST.resolveDescription(ast) ?? context.inheritedDescription;
  if (description === undefined) throw new Error(`Missing description for ${displayPath(context.authoredPath)}`);
  return description;
}

function tomlValue(value: ConfigValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (isDictionary(value)) return `{ ${Object.entries(value).map(([key, item]) => `${quoteSegment(key)} = ${tomlValue(item)}`).join(", ")} }`;
  if (value === null) throw new Error("TOML does not support null values");
  throw new Error(`Unsupported TOML example value: ${String(value)}`);
}



function authoredValue(path: readonly string[], value: ConfigValue): ConfigValue {
  if (!Array.isArray(value) || !value.every((member) => typeof member === "string")) return value;
  if (path[0] !== "disabled_modules") return value;
  return persistedDisabledModuleIds(value);
}

function leafEntry(ast: SchemaAST.AST, context: TraversalContext, defaults: ConfigValue): ConfigReferenceEntry {
  const decoded = context.schemaPath.includes("*") ? undefined : valueAtPath(defaults, context.schemaPath);
  const decodedDefault = authoredValue(context.authoredPath, decoded);
  const defaultState: ConfigDefaultState = decodedDefault === undefined ? { kind: "unset" } : { kind: "decoded", value: decodedDefault };
  const exampleValue = decodedDefault ?? sample(ast, context.schemaPath);
  const constraints = constraintOracle(ast);
  const example = context.ownership === "runtime-owned" ? undefined : serializeToml(context.exampleModel(exampleValue));
  return {
    path: displayPath(context.authoredPath),
    schemaPath: displayPath(context.schemaPath),
    authoredSegments: context.authoredPath,
    schemaSegments: context.schemaPath,
    examplePath: displayPath(context.concretePath),
    concreteSegments: context.concretePath,
    description: descriptionOf(ast, context),
    ownership: context.ownership,
    authored: true,
    type: typeOf(ast),
    constraints,
    defaultState,
    ...(decodedDefault === undefined ? {} : { defaultValue: decodedDefault }),
    sensitivity: SchemaAST.resolveAt<boolean>("sensitive")(ast) === true ? "sensitive" : "public",
    ...(context.branch === undefined ? {} : { branch: context.branch }),
    exampleValue,
    ...(example === undefined ? {} : { example }),
    snippet: example ?? `# ${displayPath(context.authoredPath)} is written by Flywheel at runtime.`,
  };
}

function traverse(ast: SchemaAST.AST, context: TraversalContext, defaults: ConfigValue): ConfigReferenceEntry[] {
  if (isNever(ast)) return [];
  if (SchemaAST.isUnion(ast)) {
    const objectBranches = ast.types.filter(SchemaAST.isObjects);
    if (objectBranches.length > 0 && objectBranches.length === ast.types.filter((member) => !isNever(member)).length) {
      return objectBranches.flatMap((member, index) => {
        const dynamicEntry = context.authoredPath.at(-1) === "*";
        const concreteKey = `${context.concretePath.at(-1) ?? "example"}-${index + 1}`;
        return traverse(member, {
          ...context,
          concretePath: dynamicEntry ? [...context.concretePath.slice(0, -1), concreteKey] : context.concretePath,
          branch: SchemaAST.resolveDescription(member) ?? `branch-${index + 1}`,
          exampleModel: dynamicEntry ? (value) => renameExampleKey(context.exampleModel(value), context.concretePath, concreteKey) : context.exampleModel,
        }, defaults);
      });
    }
    return [leafEntry(ast, context, defaults)];
  }
  if (SchemaAST.isObjects(ast)) {
    const entries: ConfigReferenceEntry[] = [];
    for (const property of ast.propertySignatures) {
      if (typeof property.name !== "string" || isNever(property.type)) continue;
      const propertyName = property.name;
      const parentExampleModel = context.exampleModel;
      entries.push(...traverse(property.type, {
        ...context,
        schemaPath: [...context.schemaPath, propertyName],
        authoredPath: [...context.authoredPath, propertyName],
        concretePath: [...context.concretePath, propertyName],
        inheritedDescription: SchemaAST.resolveDescription(property.type) ?? context.inheritedDescription,
        exampleModel: (value) => parentExampleModel(objectExample(ast, propertyName, value)),
      }, defaults));
    }
    for (const index of ast.indexSignatures) {
      const concrete = exampleKey(ast);
      const parentExampleModel = context.exampleModel;
      const childContext = {
        ...context,
        schemaPath: [...context.schemaPath, "*"],
        authoredPath: [...context.authoredPath, "*"],
        concretePath: [...context.concretePath, concrete],
        inheritedDescription: SchemaAST.resolveDescription(ast) ?? context.inheritedDescription,
        exampleModel: (value: ConfigValue) => parentExampleModel(objectExample(ast, concrete, value)),
      };
      if (SchemaAST.isUnknown(index.type) || SchemaAST.isAny(index.type)) {
        entries.push({ ...leafEntry(index.type, childContext, defaults), openVocabulary: "open record" });
      } else {
        entries.push(...traverse(index.type, childContext, defaults));
      }
    }
    return entries;
  }
  return [leafEntry(ast, context, defaults)];
}

function mergeModel(target: ConfigDictionary, source: ConfigDictionary): void {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (isDictionary(current) && isDictionary(value)) mergeModel(current, value);
    else target[key] = value;
  }
}

function serializeToml(value: ConfigDictionary, prefix: readonly string[] = []): string {
  const scalars = Object.entries(value).filter(([, item]) => !isDictionary(item));
  const tables = Object.entries(value).filter(([, item]) => isDictionary(item));
  const lines: string[] = [];
  if (prefix.length > 0 && scalars.length > 0) lines.push(`[${displayPath(prefix)}]`);
  for (const [key, item] of scalars) lines.push(`${quoteSegment(key)} = ${tomlValue(item)}`);
  for (const [key, item] of tables) {
    if (isDictionary(item)) {
      if (lines.length > 0) lines.push("");
      lines.push(serializeToml(item, [...prefix, key]));
    }
  }
  return lines.join("\n");
}

function dynamicDefault(entry: ConfigReferenceEntry, definition: Definition, authoredPath: readonly string[], schemaPath: readonly string[]): ConfigValue {
  if (!entry.schemaSegments.includes("*") || entry.example === undefined) return undefined;
  const parsed = configValue(Bun.TOML.parse(entry.example));
  const input = valueAtPath(parsed, authoredPath);
  if (!isDictionary(input)) return undefined;
  const relativePath = entry.concreteSegments.slice(authoredPath.length);
  const result = Schema.decodeUnknownResult(Schema.make<Schema.Decoder<unknown, never>>(definition.schema.ast))(withoutPath(input, relativePath));
  if (Result.isFailure(result)) return undefined;
  return valueAtPath(configValue(result.success), entry.concreteSegments.slice(schemaPath.length));
}

export function configReferenceFor(definitions: readonly Definition[], schema: Schema.Decoder<unknown, never>): ConfigReference {
  const defaults = decodedDefaults(schema);
  const root = schema.ast;
  if (!SchemaAST.isObjects(root)) throw new Error("Configuration schema root must be a struct");
  const schemaRoots = new Set(root.propertySignatures.flatMap((property) => typeof property.name === "string" ? [property.name] : []));
  const definitionRoots = new Set(definitions.flatMap((definition) => schemaRootPath(definitionPath(definition))[0] ?? []));
  for (const rootName of schemaRoots) if (!definitionRoots.has(rootName)) throw new Error(`Unresolved configuration reference: ${rootName}`);

  const entries: ConfigReferenceEntry[] = [];
  for (const definition of definitions) {
    const authoredPath = definitionPath(definition);
    const schemaPath = schemaRootPath(authoredPath);
    const schemaRoot = schemaPath[0];
    if (schemaRoot === undefined || !schemaRoots.has(schemaRoot)) throw new Error(`Unresolved configuration reference: ${schemaRoot ?? "<empty>"}`);
    const presentationDescription = isPresentedSettingId(definition.id) ? presentedSettingRow(definition.id).description : undefined;
    const schemaDescription = SchemaAST.resolveDescription(definition.schema.ast);
    if (presentationDescription !== undefined && schemaDescription !== undefined && presentationDescription !== schemaDescription) throw new Error(`Conflicting descriptions for ${displayPath(authoredPath)}`);
    const definitionEntries = traverse(definition.schema.ast, {
      schemaPath,
      authoredPath,
      concretePath: authoredPath,
      ownership: ownershipOf(definition),
      inheritedDescription: presentationDescription ?? schemaDescription ?? definition.owner,
      exampleModel: (value) => modelAtPath(authoredPath, value),
    }, defaults);
    entries.push(...definitionEntries.map((entry) => {
      const decodedDefault = dynamicDefault(entry, definition, authoredPath, schemaPath);
      return decodedDefault === undefined ? entry : { ...entry, defaultState: { kind: "decoded" as const, value: decodedDefault }, defaultValue: decodedDefault };
    }));
  }

  const exampleModel: ConfigDictionary = {};
  for (const entry of entries) {
    if (entry.example === undefined) continue;
    const parsed = Bun.TOML.parse(entry.example);
    if (!isDictionary(parsed)) throw new Error(`Invalid generated example for ${entry.path}`);
    mergeModel(exampleModel, parsed);
  }
  const example = serializeToml(exampleModel);
  const schemaModel = { ...exampleModel };
  if (Object.hasOwn(schemaModel, "disabled_modules")) {
    const selection = moduleSelectionFromConfig(schemaModel);
    if (!selection.ok) throw new Error(selection.error);
    delete schemaModel.disabled_modules;
    schemaModel.modules = selection.moduleIds;
  }
  Schema.decodeUnknownSync(schema)(schemaModel);
  return { entries, example, exampleModel };
}

function decodedDefaults(schema: Schema.Decoder<unknown, never>): ConfigValue {
  try {
    return configValue(Schema.decodeUnknownSync(schema)({}));
  } catch {
    return {};
  }
}

function configValue(value: unknown): ConfigValue {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(configValue);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, configValue(child)]));
  throw new Error(`Unsupported configuration value: ${String(value)}`);
}

function isDictionary(value: unknown): value is ConfigDictionary {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

let reference: ConfigReference | undefined;

/** The reference for the installed setting definitions, built on first use.
 *  Building it composes the module catalog and renders an example for every
 *  setting, which is work no launch needs before a config issue is reported;
 *  deferring it also keeps the catalog out of the config layer's import-time
 *  evaluation, which the catalog's own tool factories reach. */
export function configReference(): ConfigReference {
  reference ??= configReferenceFor(settingDefinitions(), installedConfigSchema());
  return reference;
}

export function configReferenceEntry(path: readonly string[]): ConfigReferenceEntry | undefined {
  return configReference().entries.find((entry) => entry.schemaSegments.length === path.length
    && entry.schemaSegments.every((segment, index) => segment === "*" || segment === path[index]));
}

export function configPath(path: readonly string[]): string {
  return displayPath(path.map((segment, index) => {
    const entry = configReferenceEntry(path.slice(0, index + 1));
    return entry?.authoredSegments[index] === "*" ? segment : entry?.authoredSegments[index] ?? segment;
  }));
}
