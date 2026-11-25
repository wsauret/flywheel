export function sanitizeDigitInput(text: string): string {
  return /^\d+$/.test(text) ? text : ""
}

export function sanitizeDigitPaste(text: string): string {
  return /^[\d,\s]+$/.test(text) ? text.replace(/\D/g, "") : ""
}

export function parseDigits(text: string): number | undefined {
  if (!/^\d+$/.test(text)) return undefined
  const value = Number(text)
  return Number.isSafeInteger(value) ? value : undefined
}

export function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}
