// Built-ins use bare tokens (`new`). Workflows use namespaced tokens
// (`workflow:triage`). One grammar
// for every reader: the terminal's dispatcher routes with it, and the runtime's
// usage store admits recorded tokens with it, so a count can never name a
// token no client could type.
export const SLASH_COMMAND_PATTERN = /^\/([a-z][\w.-]*(?::[a-z][\w.-]*)?)(?:\s+([\s\S]+))?$/i

/** The lowercased command token of a slash invocation, or undefined when the
 *  text is not a slash command. */
export function slashCommandToken(text: string): string | undefined {
  return SLASH_COMMAND_PATTERN.exec(text)?.[1]?.toLowerCase()
}
