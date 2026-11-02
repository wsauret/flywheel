// Silences TS7016 from @opentui/solid's solid-plugin.ts which imports
// @babel/core without type declarations. Safe to remove if the dependency
// ships its own types or is dropped.
declare module "@babel/core"

// Bundled models.dev snapshot (JSON content in a .txt file so tsc does not
// materialize a 3 MB literal type via resolveJsonModule). Bun's text loader
// resolves .txt imports to the file contents as a string, both at runtime and
// when inlined by Bun.build for the compiled binary.
declare module "*.txt" {
  const text: string;
  export default text;
}

// A committed workflow file that a module imports with `with { type: "text" }`,
// such as the composition probe's fixture. Bun's text loader resolves it to
// the file contents and inlines them in the compiled binary.
declare module "*.workflow.yaml" {
  const text: string;
  export default text;
}
