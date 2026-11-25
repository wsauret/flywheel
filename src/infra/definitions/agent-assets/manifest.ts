// Agent asset manifest: static source of the runner-universal system prompt.
//
// Defaults to empty (dev mode reads from the filesystem instead).
// build-binary.ts populates this with real content before bundling,
// so compiled binaries carry the prompt text inline.

export const systemPromptText = "";
export const engineeringDoctrineText = "";
