import { Schema } from "effect"

interface FactDefinition<
  T extends string,
  V extends number,
  A extends Schema.Decoder<unknown, never>,
  P extends Schema.Decoder<unknown, never>,
> {
  type: T
  version: V
  actor: A
  payload: P
}

const FACT_DEFINITION = Symbol("flywheel.factDefinition")

export type FactSchema<
  T extends string,
  V extends number,
  A extends Schema.Decoder<unknown, never>,
  P extends Schema.Decoder<unknown, never>,
> = Schema.Struct<{
  type: Schema.Literal<T>
  version: Schema.Literal<V>
  actor: A
  payload: P
}> & {
  readonly [FACT_DEFINITION]: {
    readonly type: T
    readonly version: V
  }
}

export type AnyFactSchema = FactSchema<
  string,
  number,
  Schema.Decoder<unknown, never>,
  Schema.Decoder<unknown, never>
>

interface AnyFact {
  type: string
  version: number
  actor: string
  payload: unknown
}

function keyFor(type: string, version: number): string {
  return `${type}@${version}`
}

export function defineFact<
  T extends string,
  V extends number,
  A extends Schema.Decoder<unknown, never>,
  P extends Schema.Decoder<unknown, never>,
>(opts: FactDefinition<T, V, A, P>): FactSchema<T, V, A, P> {
  const schema = Schema.Struct({
    type: Schema.Literal(opts.type),
    version: Schema.Literal(opts.version),
    actor: opts.actor,
    payload: opts.payload,
  })
  Object.defineProperty(schema, FACT_DEFINITION, {
    value: { type: opts.type, version: opts.version },
    enumerable: false,
  })
  // SAFETY: the FACT_DEFINITION symbol property was just installed via
  // defineProperty; TypeScript cannot track a runtime-added symbol-keyed brand, so
  // the cast re-states the brand on the Struct we know now carries it.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: defineProperty installs the symbol brand that TypeScript cannot infer
  return schema as FactSchema<T, V, A, P>
}

// Dispatch probe only: reads type/version to find the registered schema, which
// then strictly parses the full input. This envelope is never the gate.
const FactEnvelopeSchema = Schema.Struct({
  type: Schema.String,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  actor: Schema.String,
  payload: Schema.Unknown,
})

export function collectFactSchemas(groups: readonly (readonly AnyFactSchema[])[]): readonly AnyFactSchema[] {
  const schemas = groups.flatMap((group) => [...group])
  return [...schemas].sort((left, right) => {
    const a = left[FACT_DEFINITION]
    const b = right[FACT_DEFINITION]
    return a.type === b.type ? a.version - b.version : a.type.localeCompare(b.type)
  })
}

export function factTypes(schemas: readonly AnyFactSchema[]): readonly string[] {
  return schemas.map((schema) => schema[FACT_DEFINITION].type)
}

export function factDescriptors(schemas: readonly AnyFactSchema[]): readonly { type: string; version: number }[] {
  return schemas.map((schema) => schema[FACT_DEFINITION])
}

export function createFactParser(schemas: Iterable<AnyFactSchema>): <T extends AnyFact = AnyFact>(input: typeof Schema.Unknown.Type) => T {
  const registry = new Map<string, Schema.Decoder<unknown, never>>()
  for (const schema of schemas) {
    const { type, version } = schema[FACT_DEFINITION]
    const key = keyFor(type, version)
    if (registry.has(key)) throw new Error(`event ${key} already defined; rename one of the colliding facts`)
    registry.set(key, schema)
  }

  return function parseFact<T extends AnyFact = AnyFact>(input: typeof Schema.Unknown.Type): T {
    const envelope = Schema.decodeUnknownSync(FactEnvelopeSchema)(input)
    const schema = registry.get(keyFor(envelope.type, envelope.version))
    if (!schema) {
      throw new Error(`unknown fact ${envelope.type}@${envelope.version}; not registered`)
    }
    // SAFETY: the registry stores each fact schema erased to Decoder<unknown,never>,
    // so its strict decode result is typed `unknown`; the type+version key selected
    // the schema that validates exactly the caller's expected fact T.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the selected fact schema validates the caller's generic fact type
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input) as T
  }
}
