import { Schema } from "effect"
import type { ContainedFileMetadata } from "../../infra/descriptor-directory.js"

export const FileAccessProofSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("posix"), mode: Schema.Number.check(Schema.makeFilter(mode => Number.isInteger(mode) && mode >= 0)) }),
  Schema.Struct({ kind: Schema.Literal("win32"), daclBase64: Schema.String }),
])

export type FileAccessProof = typeof FileAccessProofSchema.Type

/** Encodes captured access metadata without changing mode bits or DACL bytes. */
export function fileAccessProof(metadata: ContainedFileMetadata): FileAccessProof {
  return metadata.kind === "posix"
    ? { kind: "posix", mode: metadata.mode }
    : { kind: "win32", daclBase64: metadata.dacl.toString("base64") }
}

/** Decodes operation-cell access with the historical cell's excess-field policy. */
export function parseFileAccessProof(value: unknown): FileAccessProof {
  try {
    return Schema.decodeUnknownSync(FileAccessProofSchema)(value)
  } catch (cause) {
    throw new Error("Invalid file access proof", { cause })
  }
}
