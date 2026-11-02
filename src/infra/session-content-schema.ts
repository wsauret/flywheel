import { Schema } from "effect"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const SESSION_CONTENT_WINDOW_BYTES = 64 * 1024
export const SessionContentReferenceSchema = Schema.Struct({
  version: Schema.Literal(1), root: Hash, bytes: Count, sha256: Hash,
})
export const SessionContentManifestReferenceSchema = Schema.Struct({
  version: Schema.Literal(1), root: Hash, bytes: Count, entries: Count,
})
