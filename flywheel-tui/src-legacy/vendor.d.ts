// Silences TS7016 from @opentui/solid's solid-plugin.ts which imports
// @babel/core without type declarations. Safe to remove if the dependency
// ships its own types or is dropped.
declare module "@babel/core"
