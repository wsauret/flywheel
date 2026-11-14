/** Remove the spaces, dashes, dots, and parentheses a patient types in a phone number. */
export function normalizePhone(raw: string): string {
  return raw.replace(/[\s\-().]/g, "");
}
