import type { TextareaRenderable, PasteEvent, SyntaxStyle } from "@opentui/core"

const PASTE_CHAR_THRESHOLD = 200
const PASTE_LINE_THRESHOLD = 4

function countVisualLines(text: string, width: number): { collapse: boolean; lineCount: number } {
  const cols = width > 0 ? width : 80
  let visualLines = 0
  const lines = text.split("\n")
  for (const line of lines) {
    visualLines += line.length === 0 ? 1 : Math.ceil(line.length / cols)
  }
  const collapse = text.length > PASTE_CHAR_THRESHOLD || visualLines > PASTE_LINE_THRESHOLD
  return { collapse, lineCount: visualLines }
}

export function createPasteCollapse(
  textarea: TextareaRenderable,
  syntax: SyntaxStyle,
): { handlePaste: (event: PasteEvent) => void; expandForSubmit: () => string } {
  textarea.syntaxStyle = syntax
  const typeId = textarea.extmarks.registerType("paste")
  const styleId = syntax.resolveStyleId("extmark.paste") ?? undefined

  function handlePaste(event: PasteEvent): void {
    const text = event.text
    const { collapse, lineCount } = countVisualLines(text, textarea.width)
    if (!collapse) return

    event.preventDefault()

    const placeholder = `[Pasted ~${lineCount} lines]`
    const startOffset = textarea.editBuffer.getCursorPosition().offset

    textarea.insertText(placeholder)

    textarea.extmarks.create({
      start: startOffset,
      end: startOffset + placeholder.length,
      virtual: true,
      typeId,
      data: text,
      ...(styleId !== undefined ? { styleId } : {}),
    })
  }

  function expandForSubmit(): string {
    const extmarks = textarea.extmarks.getAllForTypeId(typeId)
    if (extmarks.length === 0) return textarea.plainText

    extmarks.sort((a, b) => b.start - a.start)

    let result = textarea.plainText
    for (const ext of extmarks) {
      if (ext.data) {
        result = result.slice(0, ext.start) + ext.data + result.slice(ext.end)
      }
    }
    return result
  }

  return { handlePaste, expandForSubmit }
}
