import { Schema } from "effect"
import * as SchemaAST from "effect/SchemaAST"

/** Returns every leaf codec in a possibly nested union while preserving declaration order. */
export function recursiveUnionMembers<S extends Schema.Top>(schema: S): readonly S[] {
  if (!SchemaAST.isUnion(schema.ast)) return [schema]
  return schema.ast.types.flatMap((member) => {
    // SAFETY: each member AST came from this codec's union and is therefore a subtype of its decoded and encoded values with the same requirements.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- protocol schema union member
    return recursiveUnionMembers(Schema.make(member) as S)
  })
}

/** Reads one required string-literal discriminator from every leaf of a protocol union. */
export function stringDiscriminatorLiterals(schema: Schema.Top, propertyName: string): readonly string[] {
  return recursiveUnionMembers(schema).map((member) => {
    const ast = member.ast
    if (!SchemaAST.isObjects(ast)) throw new Error(`Expected an object or union while reading '${propertyName}' discriminators`)
    const property = ast.propertySignatures.find((candidate) => candidate.name === propertyName)
    if (property === undefined || SchemaAST.isOptional(property.type) || !SchemaAST.isLiteral(property.type) || typeof property.type.literal !== "string") {
      throw new Error(`Expected required string literal discriminator '${propertyName}'`)
    }
    return property.type.literal
  })
}
