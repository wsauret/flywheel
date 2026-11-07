export interface UnknownRecord { [key: string]: unknown }

export function isRecord<Input>(value: Input): value is Input & UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function asRecord<Input>(value: Input): (Input & UnknownRecord) | undefined {
  return isRecord(value) ? value : undefined
}
