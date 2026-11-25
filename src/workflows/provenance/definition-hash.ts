import { createHash } from "node:crypto"
import { Schema } from "effect"

/** What a hashing call returns: the digest and the byte count it covered. */
export interface ContentHash {
  readonly sha256: string
  readonly bytes: number
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`

  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`
}

export function hashContent(value: string): ContentHash {
  return {
    sha256: createHash("sha256").update(value).digest("hex"),
    bytes: Buffer.byteLength(value, "utf8"),
  }
}

export function hashDefinition(value: unknown): ContentHash {
  return hashContent(canonicalJson(value))
}

/** The canonical shape of every definition hash this module produces. */
export const Sha256Schema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
