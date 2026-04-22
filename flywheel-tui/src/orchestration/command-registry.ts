interface CommandHandler {
  pattern: RegExp
  execute(match: RegExpMatchArray, text: string): boolean | Promise<boolean>
}

interface CommandRegistry {
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
