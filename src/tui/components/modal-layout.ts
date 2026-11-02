type ResponsivePaneMode = "split" | "stacked"

export interface ResponsivePaneLayout {
  readonly mode: ResponsivePaneMode
  readonly listWidth: number
  readonly previewWidth: number
  readonly listHeight: number
  readonly previewHeight: number
  readonly gap: number
}

const TWO_PANE_BREAKPOINT = 120

export function computeModalWidth(termWidth: number, maxWidth: number): number {
  if (termWidth <= 84) return Math.max(24, termWidth)
  return Math.max(24, Math.min(maxWidth, termWidth - 4))
}

export function computeModalListHeight(termHeight: number, reservedRows: number, maxHeight = 18): number {
  const height = Number.isFinite(termHeight) && termHeight > 0 ? termHeight : 24
  return Math.max(4, Math.min(maxHeight, height - reservedRows))
}

export function computeResponsivePaneLayout(termWidth: number, contentWidth: number, contentHeight: number): ResponsivePaneLayout {
  const width = Math.max(0, Math.floor(contentWidth))
  const height = Math.max(1, Math.floor(contentHeight))
  const gap = 1

  if (termWidth < TWO_PANE_BREAKPOINT) {
    const availableHeight = Math.max(2, height - gap)
    const listHeight = Math.max(1, Math.floor(availableHeight / 2))
    return {
      mode: "stacked",
      listWidth: width,
      previewWidth: width,
      listHeight,
      previewHeight: Math.max(1, availableHeight - listHeight),
      gap,
    }
  }

  const availableWidth = Math.max(0, width - gap)
  const listWidth = Math.floor(availableWidth / 2)
  return {
    mode: "split",
    listWidth,
    previewWidth: availableWidth - listWidth,
    listHeight: height,
    previewHeight: height,
    gap,
  }
}
