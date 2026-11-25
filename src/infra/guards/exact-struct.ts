import { Effect, Schema, SchemaIssue } from "effect";

/** The struct, refusing every key it does not declare, whatever parse options
 *  the decode or encode runs with.
 *
 *  Effect reads `onExcessProperty` only from the options of one whole parse,
 *  so a strict decode of one node inside a lenient message needs the node to
 *  carry the rule itself. An undeclared key matches the rest signature, and its
 *  value fails with the struct's own `UnexpectedKey` issue at the key's path,
 *  so the report reads as the parser's own excess-key report: the struct's
 *  `messageUnexpectedKey` annotation, or Effect's default message. The rule
 *  covers this struct only, not the structs nested in its fields. */
export function exactStruct<S extends Schema.Struct<Schema.Struct.Fields>>(
  struct: S,
): Schema.Codec<S["Type"], S["Encoded"], S["DecodingServices"], S["EncodingServices"]> {
  const declared = new Set<string>(Object.keys(struct.fields));
  const undeclaredKey = Schema.String.check(Schema.makeFilter((key: string) => !declared.has(key)));
  const unexpected = () => Effect.fail(new SchemaIssue.UnexpectedKey(struct.ast));
  const refused = Schema.Never.pipe(Schema.middlewareDecoding(unexpected), Schema.middlewareEncoding(unexpected));
  // SAFETY: the rest signature adds only keys whose value is `never`, so every
  // value it accepts is a value of the struct. Its index type would conflict
  // with every declared property, so the struct's own types state the contract.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the rest signature admits no value beyond the struct's own
  return Schema.StructWithRest(struct, [Schema.Record(undeclaredKey, refused)]) as Schema.Codec<S["Type"], S["Encoded"], S["DecodingServices"], S["EncodingServices"]>;
}
