export interface CommandHandler {
  /** Pattern to match against the trimmed input. */
  pattern: RegExp
  /** Handler to execute. Returns true if handled. */
  execute(match: RegExpMatchArray, text: string): boolean | Promise<boolean>
}

export interface CommandRegistry {
  register(handler: CommandHandler): void
  dispatch(text: string): Promise<boolean>
}

export function createCommandRegistry(): CommandRegistry {
  const handlers: CommandHandler[] = []
  return {
    register(handler) { handlers.push(handler) },
    async dispatch(text) {
      for (const h of handlers) {
        const match = text.match(h.pattern)
        if (match) {
          const handled = await h.execute(match, text)
          if (handled) return true
        }
      }
      return false
    },
  }
}
