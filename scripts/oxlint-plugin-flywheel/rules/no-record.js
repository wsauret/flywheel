const message =
  "Don't use the `Record` type. It erases or widens the value's shape, usually because an IO boundary was never parsed into a domain type. Use a named interface, a discriminated union, a Schema.Struct/Schema.Record inferred type, or a Map for dynamic keys.";

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow the Record utility type in favor of parsed domain types, named shapes, or Map.",
    },
  },
  create(context) {
    return {
      TSTypeReference(node) {
        if (node.typeName?.type !== "Identifier" || node.typeName.name !== "Record") return;
        context.report({ node, message });
      },
    };
  },
};
