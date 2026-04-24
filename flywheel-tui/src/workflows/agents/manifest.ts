// Agent manifest — static source of agent/skill/step-markdown file contents.
//
// Defaults to empty (dev mode reads from filesystem instead).
// build-binary.ts populates these with real content before bundling,
// so compiled binaries carry the .md files inline. stepMarkdown is keyed
// by path relative to `src/` (e.g. "workflows/queue/steps/sprint/preamble.md")
// and populated by scanning src/workflows/queue/steps/**/*.md at build time.

export const agents: Record<string, string> = {};

export const skills: Record<
  string,
  { skill: string; references: Record<string, string> }
> = {};

export const stepMarkdown: Record<string, string> = {};
