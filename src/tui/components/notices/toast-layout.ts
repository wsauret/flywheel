const PREFIX_WIDTH = 2

export function computeToastLayout(termWidth: number, messageLength: number) {
  const maxWidth = Math.max(24, Math.floor(termWidth * 0.8))
  const width = Math.min(messageLength + PREFIX_WIDTH + 6, maxWidth, Math.max(1, termWidth - 4))
  return {
    left: Math.max(0, termWidth - width - 2),
    width,
    textWidth: Math.max(1, width - 4),
  }
}
