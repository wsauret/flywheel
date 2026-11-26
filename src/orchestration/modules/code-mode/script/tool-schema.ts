import { JsonPointer, Schema } from "effect"
import { identifierSegment } from "../../../agent-runtime/tools/dispatch/tool-expression.js"

/** The JSON Schema subset that a Code Mode signature renders. Nothing
 *  validates a value against it: the nested dispatch decodes each input. */
export type JsonSchema = {
  readonly type?: string | ReadonlyArray<string>
  readonly enum?: ReadonlyArray<unknown>
  readonly const?: unknown
  readonly anyOf?: ReadonlyArray<JsonSchema>
  readonly oneOf?: ReadonlyArray<JsonSchema>
  readonly allOf?: ReadonlyArray<JsonSchema>
  readonly properties?: { readonly [key: string]: JsonSchema }
  readonly required?: ReadonlyArray<string>
  readonly items?: JsonSchema
  readonly additionalProperties?: boolean | JsonSchema
  readonly description?: string
  readonly default?: unknown
  readonly format?: string
  readonly deprecated?: boolean
  readonly minItems?: number
  readonly maxItems?: number
  readonly $ref?: string
  readonly $defs?: { readonly [key: string]: JsonSchema }
  readonly definitions?: { readonly [key: string]: JsonSchema }
}

/** Either an Effect Schema or a render-only JSON Schema document. */
type SchemaType = Schema.Top | JsonSchema

/** The two schemas that one callable's signature renders. */
export interface ToolSignature {
  readonly input: SchemaType
  /** Absent renders `void`. */
  readonly output?: SchemaType | undefined
}

type Definitions = { readonly [key: string]: JsonSchema }

type JsonSchemaDocument = {
  readonly schema: JsonSchema
  readonly definitions?: Definitions
}

// SAFETY: Effect writes a JSON Schema document, which this renderer reads through the subset above.
// oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: Effect types its JSON Schema document as an open object, and the renderer treats every key outside the subset as absent
const jsonSchemaDocument = (schema: Schema.Top): JsonSchemaDocument => Schema.toJsonSchemaDocument(schema) as JsonSchemaDocument

const renderLiteral = (value: unknown): string => JSON.stringify(value) ?? "unknown"

const renderKey = (name: string): string => (identifierSegment.test(name) ? name : JSON.stringify(name))

const definitionName = (ref: string): string | undefined => {
  const segment = /^#\/(?:\$defs|definitions)\/([^/]+)$/.exec(ref)?.[1]
  return segment === undefined ? undefined : JsonPointer.unescapeToken(segment)
}

const numberSentinels: ReadonlySet<unknown> = new Set(["NaN", "Infinity", "-Infinity"])

/** The string enum beside `number` in Effect's JSON Schema of `Schema.Number`,
 *  which states the non-finite values its JSON encoding writes as strings. */
const effectNumberSentinel = (schema: JsonSchema): boolean =>
  schema.type === "string" &&
  Array.isArray(schema.enum) &&
  schema.enum.length > 0 &&
  schema.enum.every((value) => numberSentinels.has(value))

const intersection = (members: ReadonlyArray<string>): string => {
  const concrete = members.filter((member) => member !== "unknown")
  if (concrete.length <= 1) return concrete[0] ?? "unknown"
  return concrete.map((member) => (member.includes(" | ") ? `(${member})` : member)).join(" & ")
}

const MAX_RENDER_DEPTH = 8

type RenderContext = {
  readonly definitions: Definitions
  readonly pretty: boolean
}

const hasUnresolvedRef = (
  schema: JsonSchema,
  definitions: Definitions,
  seen: ReadonlySet<string> = new Set(),
  visited: ReadonlySet<JsonSchema> = new Set(),
): boolean => {
  if (visited.has(schema)) return false
  const nextVisited = new Set([...visited, schema])
  if (schema.$ref !== undefined) {
    const name = definitionName(schema.$ref)
    const target = name === undefined ? undefined : definitions[name]
    if (name === undefined || target === undefined || seen.has(name)) return true
    if (hasUnresolvedRef(target, definitions, new Set([...seen, name]), nextVisited)) return true
  }
  return [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
    ...Object.values(schema.properties ?? {}),
    ...(schema.items === undefined ? [] : [schema.items]),
    ...(typeof schema.additionalProperties === "object" ? [schema.additionalProperties] : []),
  ].some((item) => hasUnresolvedRef(item, definitions, seen, nextVisited))
}

const docTags = (schema: JsonSchema): Array<string> => {
  const tags: Array<string> = []
  if (schema.deprecated === true) tags.push("@deprecated")
  if (schema.default !== undefined) {
    try {
      const rendered = JSON.stringify(schema.default)
      if (rendered !== undefined) tags.push(`@default ${rendered}`)
    } catch {
      // A default that JSON cannot write, such as a BigInt or a cycle, gets no tag.
    }
  }
  if (typeof schema.format === "string") tags.push(`@format ${schema.format}`)
  if (typeof schema.minItems === "number") tags.push(`@minItems ${schema.minItems}`)
  if (typeof schema.maxItems === "number") tags.push(`@maxItems ${schema.maxItems}`)
  return tags
}

// Neutralize `*\/` so model-provided schema text cannot terminate generated documentation.
const jsdoc = (description: string | undefined, tags: ReadonlyArray<string>, pad: string): string => {
  const lines = [...(description === undefined ? [] : description.split("\n")), ...tags].map((line) =>
    line.replaceAll("*/", "* /").replace(/\s+$/, ""),
  )
  while (lines[0]?.trim() === "") lines.shift()
  while (lines.at(-1)?.trim() === "") lines.pop()
  if (lines.length === 0) return ""
  if (lines.length === 1) return `${pad}/** ${lines[0]} */\n`
  const body = lines.map((line) => `${pad} *${line === "" ? "" : ` ${line}`}`).join("\n")
  return `${pad}/**\n${body}\n${pad} */\n`
}

const renderSchema = (
  schema: JsonSchema,
  ctx: RenderContext,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): string => {
  if (depth > MAX_RENDER_DEPTH) return "unknown"
  const nested =
    schema.definitions === undefined && schema.$defs === undefined
      ? ctx
      : { ...ctx, definitions: { ...ctx.definitions, ...schema.definitions, ...schema.$defs } }
  if (schema.$ref !== undefined && schema.$ref !== "") {
    const name = definitionName(schema.$ref)
    const target = name === undefined ? undefined : nested.definitions[name]
    if (name === undefined || target === undefined || seen.has(name)) return "unknown"
    return intersection([
      renderSchema(target, nested, depth, new Set([...seen, name])),
      renderSchema({ ...schema, $ref: undefined }, nested, depth + 1, seen),
    ])
  }
  if (schema.const !== undefined) return renderLiteral(schema.const)
  if (schema.enum) return schema.enum.map(renderLiteral).join(" | ")
  const alternatives = schema.anyOf ?? schema.oneOf
  if (alternatives) {
    if (
      alternatives.some((item) => item.type === "number") &&
      alternatives.every((item) => item.type === "number" || effectNumberSentinel(item))
    )
      return "number"
    const [first, second] = alternatives
    if (
      alternatives.length === 2 &&
      first?.type === "object" &&
      first.properties === undefined &&
      second?.type === "array" &&
      second.items === undefined
    ) {
      return "{}"
    }
    const members = alternatives.map((item) => renderSchema(item, nested, depth + 1, seen))
    if (members.includes("unknown")) return "unknown"
    return intersection([
      members.join(" | "),
      renderSchema({ ...schema, anyOf: undefined, oneOf: undefined }, nested, depth + 1, seen),
    ])
  }
  if (schema.allOf) {
    const members = schema.allOf.map((item) => renderSchema(item, nested, depth + 1, seen))
    if (schema.allOf.some((item) => hasUnresolvedRef(item, nested.definitions))) return "unknown"
    return intersection([renderSchema({ ...schema, allOf: undefined }, nested, depth + 1, seen), ...members])
  }
  if (Array.isArray(schema.type)) {
    return schema.type.map((item) => renderSchema({ ...schema, type: item }, nested, depth + 1, seen)).join(" | ")
  }
  if (schema.type === "string") return "string"
  if (schema.type === "number" || schema.type === "integer") return "number"
  if (schema.type === "boolean") return "boolean"
  if (schema.type === "null") return "null"
  if (schema.type === "array") return `Array<${renderSchema(schema.items ?? {}, nested, depth + 1, seen)}>`
  if (schema.type === "object" || schema.properties) {
    const required = new Set(schema.required)
    const properties = Object.entries(schema.properties ?? {})
    const additional = schema.additionalProperties
    const indexType =
      additional && typeof additional === "object" ? renderSchema(additional, nested, depth + 1, seen) : undefined
    const field = ([name, value]: readonly [string, JsonSchema]) =>
      `${renderKey(name)}${required.has(name) ? "" : "?"}: ${renderSchema(value, nested, depth + 1, seen)}`

    if (!ctx.pretty) {
      const fields = properties.map(field)
      if (indexType !== undefined) fields.push(`[key: string]: ${indexType}`)
      return fields.length === 0 ? "{}" : `{ ${fields.join("; ")} }`
    }

    if (properties.length === 0 && indexType === undefined) return "{}"
    const pad = "  ".repeat(depth + 1)
    const lines = properties.map(
      (entry) => `${jsdoc(entry[1].description, docTags(entry[1]), pad)}${pad}${field(entry)},`,
    )
    if (indexType !== undefined) lines.push(`${pad}[key: string]: ${indexType},`)
    return `{\n${lines.join("\n")}\n${"  ".repeat(depth)}}`
  }
  return "unknown"
}

const effectSchemaToTypeScript = (schema: Schema.Top, decoded: boolean, pretty: boolean): string => {
  try {
    const document = jsonSchemaDocument(decoded ? Schema.toType(schema) : schema)
    return renderSchema(document.schema, { definitions: document.definitions ?? {}, pretty })
  } catch {
    return "unknown"
  }
}

/** Renders a JSON Schema as a TypeScript type; `pretty` writes one field per
 *  line with its description and constraints as JSDoc. Never throws. */
export const jsonSchemaToTypeScript = (schema: JsonSchema, pretty = false): string => {
  try {
    return renderSchema(schema, { definitions: { ...schema.definitions, ...schema.$defs }, pretty })
  } catch {
    return "unknown"
  }
}

export type InputProperty = {
  readonly name: string
  readonly description: string | undefined
}

/** The top-level input fields of a signature, which search matches against. */
export const inputProperties = (signature: ToolSignature): Array<InputProperty> => {
  try {
    const { input } = signature
    const document: JsonSchemaDocument = Schema.isSchema(input)
      ? jsonSchemaDocument(input)
      : { schema: input, definitions: { ...input.definitions, ...input.$defs } }
    const definitions = document.definitions ?? {}
    let schema = document.schema
    if (schema.$ref !== undefined) {
      const name = definitionName(schema.$ref)
      const resolved = name === undefined ? undefined : definitions[name]
      if (resolved === undefined) return []
      schema = resolved
    }
    return Object.entries(schema.properties ?? {}).map(([name, value]) => ({
      name,
      description: typeof value.description === "string" ? value.description : undefined,
    }))
  } catch {
    return []
  }
}

export const inputTypeScript = (signature: ToolSignature, pretty = false): string =>
  Schema.isSchema(signature.input)
    ? effectSchemaToTypeScript(signature.input, false, pretty)
    : jsonSchemaToTypeScript(signature.input, pretty)

export const outputTypeScript = (signature: ToolSignature, pretty = false): string =>
  signature.output === undefined
    ? "void"
    : Schema.isSchema(signature.output)
      ? effectSchemaToTypeScript(signature.output, true, pretty)
      : jsonSchemaToTypeScript(signature.output, pretty)
