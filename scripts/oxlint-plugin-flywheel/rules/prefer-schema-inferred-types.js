import { getCallName, getPropertyName, isIdentifier } from "../utils.js";

const message =
  "This object type duplicates a nearby Effect Schema. Export an inferred type from the schema instead (`type X = typeof XSchema.Type`).";

const schemaSuffixPattern = /(Schema|Model|Struct)$/;

// Members that CONSTRUCT a schema whose `.Type` is the source of truth. Decoder/
// encoder calls (Schema.decodeUnknownSync, ...) also live on `Schema` but return a
// function, not a schema, so they must not register a base name and falsely convict
// a sibling interface.
const schemaConstructors = new Set([
  "Struct",
  "StructWithRest",
  "Union",
  "Record",
  "Array",
  "Tuple",
  "Literal",
  "TaggedStruct",
  "TaggedError",
  "TaggedRequest",
  "brand",
]);

const schemaBaseName = (name) => {
  const base = name.replace(schemaSuffixPattern, "");
  return base.length > 0 && base !== name ? base : undefined;
};

const isSchemaMemberCall = (node) =>
  node?.type === "CallExpression" &&
  node.callee?.type === "MemberExpression" &&
  isIdentifier(node.callee.object, "Schema") &&
  schemaConstructors.has(getPropertyName(node.callee.property));

const isSchemaModelExpression = (node) => {
  if (isSchemaMemberCall(node)) return true;
  if (node?.type === "CallExpression" && getCallName(node.callee) === "pipe") {
    return isSchemaModelExpression(node.callee.object);
  }
  return false;
};

// Only an inline object type duplicates a schema's shape. An inferred
// `type X = typeof XSchema.Type` is a TSTypeQuery, not a TSTypeLiteral, so it is
// already excluded here and needs no separate exemption.
const isObjectTypeAlias = (node) => node.typeAnnotation?.type === "TSTypeLiteral";

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Derive types from a sibling Schema instead of duplicating its shape.",
    },
  },
  create(context) {
    const schemaBases = new Set();
    const candidates = [];

    return {
      VariableDeclarator(node) {
        if (!isIdentifier(node.id) || !isSchemaModelExpression(node.init)) return;
        const base = schemaBaseName(node.id.name);
        if (base) schemaBases.add(base);
      },
      TSInterfaceDeclaration(node) {
        candidates.push({ node, name: node.id?.name });
      },
      TSTypeAliasDeclaration(node) {
        if (!isObjectTypeAlias(node)) return;
        candidates.push({ node, name: node.id?.name });
      },
      "Program:exit"() {
        for (const candidate of candidates) {
          if (!candidate.name || !schemaBases.has(candidate.name)) continue;
          context.report({ node: candidate.node, message });
        }
      },
    };
  },
};
