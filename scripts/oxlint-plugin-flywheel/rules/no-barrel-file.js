const message =
  "Do not re-export with `export *`; import directly from the owning file. Barrel re-exports bloat the module graph and hide the real dependency.";

// `export * from "./x"` parses as ExportAllDeclaration with `exported === null`;
// `export * as ns from "./x"` is the same node with `exported` set to the alias.
// One rule covers both forms -- AGENTS.md's policy is simply "No barrel re-exports."
export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow `export *` re-exports; import directly from the owning file.",
    },
  },
  create(context) {
    return {
      ExportAllDeclaration(node) {
        context.report({ node, message });
      },
    };
  },
};
