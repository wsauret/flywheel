export interface SelectionConsumer {
  getSelection(): { getSelectedText(): string } | null
  clearSelection(): void
}

export function consumeSelectedText(renderer: SelectionConsumer): string | null {
  const text = renderer.getSelection()?.getSelectedText() ?? ""
  renderer.clearSelection()
  return text.length > 0 ? text : null
}
