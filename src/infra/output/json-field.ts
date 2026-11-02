/**
 * Safe typed field access over repair-parsed partial tool-call JSON.
 *
 * `parsePartialJson` yields `Record<string, unknown>` because streaming
 * tool input is heterogeneous and incomplete by nature: a field may be
 * absent, or a partial chunk may have it as the wrong type. These accessors
 * narrow with `typeof` / `Array.isArray` and return `undefined` for an
 * absent or wrong-typed field, so the rendering path degrades quietly
 * instead of mis-casting a non-string as a string.
 */

export interface JsonFields {
  [key: string]: unknown;
}

export function stringField(obj: JsonFields, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

export function textField(obj: JsonFields, key: string): string | null {
  const value = obj[key];
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\n/g, " ").trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function numberField(obj: JsonFields, key: string): number | undefined {
  const value = obj[key];
  return typeof value === "number" ? value : undefined;
}

export function arrayField(obj: JsonFields, key: string): unknown[] | undefined {
  const value = obj[key];
  return Array.isArray(value) ? value : undefined;
}
