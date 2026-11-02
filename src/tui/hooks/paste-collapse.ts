import type { Extmark, SyntaxStyle, TextareaRenderable } from "@opentui/core"
import type { ComposerDraftPaste } from "./create-draft-cache.js"

const PASTE_CHAR_THRESHOLD = 200
const PASTE_LINE_THRESHOLD = 4

function countVisualLines(text: string, width: number) {
  const columns = width > 0 ? width : 80
  let lineCount = 0
  let lineLength = 0
  for (let index = 0; index <= text.length; index += 1) {
    if (index < text.length && text.charCodeAt(index) !== 10) {
      lineLength += 1
      continue
    }
    lineCount += lineLength === 0 ? 1 : Math.ceil(lineLength / columns)
    lineLength = 0
  }
  return { collapse: text.length > PASTE_CHAR_THRESHOLD || lineCount > PASTE_LINE_THRESHOLD, lineCount }
}

export interface PasteCollapseController {
  /** Inserts one complete paste payload, collapsing it when it exceeds the display threshold. */
  applyPaste(text: string): boolean
  expandForSubmit(): string
  serialize(): readonly ComposerDraftPaste[]
  restore(pastes: readonly ComposerDraftPaste[]): void
}

/** Stores and expands large-paste extmarks. Paste classification belongs to the caller. */
export function createPasteCollapse(textarea: TextareaRenderable, syntax: () => SyntaxStyle): PasteCollapseController {
  textarea.syntaxStyle = syntax()
  const typeId = textarea.extmarks.registerType("paste")
  let destroyed = false
  let destroyedPastes: readonly ComposerDraftPaste[] = []
  const destroy = textarea.destroy.bind(textarea)
  // The destroyed event follows native editor disposal in 0.6. Capture at
  // the public destroy boundary, while the extmark owner is still alive.
  textarea.destroy = () => {
    if (!destroyed) {
      destroyedPastes = serialize()
      destroyed = true
    }
    destroy()
  }

  function createPasteExtmark(start: number, end: number, text: string): void {
    const styleId = syntax().resolveStyleId("extmark.paste") ?? undefined
    textarea.extmarks.create({
      start,
      end,
      virtual: true,
      typeId,
      data: text,
      ...(styleId === undefined ? {} : { styleId }),
    })
  }

  function applyPaste(text: string): boolean {
    if (destroyed) return false
    const { collapse, lineCount } = countVisualLines(text, textarea.width)
    if (!collapse) {
      textarea.insertText(text)
      return false
    }
    const start = textarea.editBuffer.getCursorPosition().offset
    const placeholder = `[Pasted ~${lineCount} lines]`
    textarea.insertText(placeholder)
    createPasteExtmark(start, start + placeholder.length, text)
    return true
  }

  function pastePayload(extmark: Extmark): string | undefined {
    return typeof extmark.data === "string" ? extmark.data : undefined
  }

  function serialize(): readonly ComposerDraftPaste[] {
    if (destroyed) return destroyedPastes
    return textarea.extmarks.getAllForTypeId(typeId)
      .flatMap((extmark) => {
        const text = pastePayload(extmark)
        return text === undefined ? [] : [{ start: extmark.start, end: extmark.end, text }]
      })
      .sort((left, right) => left.start - right.start)
  }

  function restore(pastes: readonly ComposerDraftPaste[]): void {
    if (destroyed) return
    for (const extmark of textarea.extmarks.getAllForTypeId(typeId)) textarea.extmarks.delete(extmark.id)
    for (const paste of pastes) createPasteExtmark(paste.start, paste.end, paste.text)
  }

  function expandForSubmit(): string {
    if (destroyed) return ""
    const extmarks = [...textarea.extmarks.getAllForTypeId(typeId)].sort((left, right) => right.start - left.start)
    let result = textarea.plainText
    for (const extmark of extmarks) {
      const text = pastePayload(extmark)
      if (text !== undefined) result = result.slice(0, extmark.start) + text + result.slice(extmark.end)
    }
    return result
  }

  return { applyPaste, expandForSubmit, serialize, restore }
}
