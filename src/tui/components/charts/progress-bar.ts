export function progressBar(fraction: number, width: number): string {
  const barWidth = Math.max(0, Math.floor(width))
  const filledWidth = Math.round(Math.max(0, Math.min(1, fraction)) * barWidth)
  return `${"█".repeat(filledWidth)}${"░".repeat(barWidth - filledWidth)}`
}
