// Agent manifest — static source of agent/skill file contents.
//
// Defaults to empty (dev mode reads from filesystem instead).
// build-binary.ts populates this with real content before bundling,
// so compiled binaries carry the .md files inline.

export const agents: Record<string, string> = {};

export const skills: Record<
  string,
  { skill: string; references: Record<string, string> }
> = {};
