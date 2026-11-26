import { Schema } from "effect"
import { toolExpression } from "../../../agent-runtime/tools/dispatch/tool-expression.js"
import { CodeToolResultSchema, type CodeModeToolDescriptor } from "../descriptors.js"
import { inputProperties, inputTypeScript, jsonSchemaToTypeScript, outputTypeScript } from "./tool-schema.js"

/** One callable tool as a script and the catalog prompt name it. */
export interface ToolDescription {
  /** The dotted tool name, such as `github.search`. */
  readonly path: string
  readonly description: string
  readonly signature: string
}

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** The input of the `searchCatalog` global. */
export const SearchInput = Schema.Struct({
  query: Schema.optionalKey(Schema.String),
  namespace: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(PositiveInt),
  offset: Schema.optionalKey(NonNegativeInt),
})
type SearchRequest = typeof SearchInput.Type

const SearchResultSchema = Schema.Struct({
  items: Schema.Array(Schema.Struct({ path: Schema.String, description: Schema.String, signature: Schema.String })),
  remaining: NonNegativeInt,
  next: Schema.NullOr(Schema.Struct({ offset: NonNegativeInt })),
})
type SearchResult = typeof SearchResultSchema.Type

/** The exact callable signature of `searchCatalog`, for the catalog prompt. */
export const searchSignature = `searchCatalog(input: ${inputTypeScript({ input: SearchInput }, true)}): ${outputTypeScript({ input: SearchInput, output: SearchResultSchema }, true)}`

const DEFAULT_SEARCH_LIMIT = 10

// Every bridged call resolves to the same result shape, so one rendering serves every signature.
const RESULT_TYPE = outputTypeScript({ input: {}, output: CodeToolResultSchema }, true)

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

const tokenize = (query: string): Array<string> =>
  query
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0 && term !== "*")

const termForms = (term: string): Array<string> => {
  const forms = [term]
  if (term.endsWith("es") && term.length > 3) forms.push(term.slice(0, -2))
  if (term.endsWith("s") && term.length > 2) forms.push(term.slice(0, -1))
  return forms
}

interface SearchEntry {
  readonly description: ToolDescription
  readonly path: string
  readonly text: string
}

/** The discovery side of one set of descriptors: the catalog that the prompt
 *  lists, and the ranked search that the `searchCatalog` global runs. */
export interface ToolCatalog {
  /** Every tool, ordered by its dotted name, so equal descriptors in any order render the same bytes. */
  readonly tools: ReadonlyArray<ToolDescription>
  readonly search: (request: SearchRequest) => SearchResult
}

export function prepareToolCatalog(descriptors: readonly CodeModeToolDescriptor[]): ToolCatalog {
  const entries: SearchEntry[] = descriptors
    .map((descriptor): SearchEntry => ({
      path: descriptor.name.toLowerCase(),
      description: {
        path: descriptor.name,
        description: descriptor.description,
        signature: `${toolExpression(descriptor.name)}(input: ${jsonSchemaToTypeScript(descriptor.inputSchema, true)}): Promise<${RESULT_TYPE}>`,
      },
      text: [
        descriptor.name,
        descriptor.description,
        ...inputProperties({ input: descriptor.inputSchema }).flatMap(({ name, description }) => description === undefined ? [name] : [name, description]),
      ].join("\n").toLowerCase(),
    }))
    .toSorted((left, right) => compareText(left.description.path, right.description.path))

  const search = (request: SearchRequest): SearchResult => {
    const query = request.query ?? ""
    const offset = request.offset ?? 0
    const { namespace } = request
    const scoped = namespace === undefined
      ? entries
      : entries.filter(({ description }) => description.path === namespace || description.path.startsWith(`${namespace}.`))
    const trimmed = query.trim()
    const pathQuery = trimmed.startsWith("tools.") ? trimmed.slice("tools.".length) : trimmed
    const exact = pathQuery === ""
      ? undefined
      : scoped.find(({ description }) => description.path === pathQuery || toolExpression(description.path) === trimmed)
    const terms = tokenize(query).map(termForms)
    const ranked = exact !== undefined
      ? [exact]
      : scoped
        .map((entry) => {
          const description = entry.description.description.toLowerCase()
          const score = terms.reduce((total, forms) =>
            total +
            (forms.some((form) => entry.path === form || entry.path.endsWith(`.${form}`)) ? 20 : 0) +
            (forms.some((form) => entry.path.includes(form)) ? 8 : 0) +
            (forms.some((form) => description.includes(form)) ? 4 : 0) +
            (forms.some((form) => entry.text.includes(form)) ? 2 : 0), 0)
          return { entry, score }
        })
        .filter(({ score }) => terms.length === 0 || score > 0)
        .toSorted((left, right) => right.score - left.score || compareText(left.entry.description.path, right.entry.description.path))
        .map(({ entry }) => entry)
    const items = ranked
      .slice(offset, offset + (request.limit ?? DEFAULT_SEARCH_LIMIT))
      .map(({ description }) => ({ ...description, path: toolExpression(description.path) }))
    const remaining = Math.max(0, ranked.length - offset - items.length)
    return { items, remaining, next: remaining > 0 ? { offset: offset + items.length } : null }
  }

  return { tools: entries.map(({ description }) => description), search }
}
