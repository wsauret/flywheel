import type { ContainedFileMetadata, ContainedFileSnapshot } from "../../../../src/infra/descriptor-directory.js"

export function mutationSnapshot(content: string, metadata: ContainedFileMetadata = { kind: "posix", mode: 0o640 }): ContainedFileSnapshot {
  return { content: Buffer.from(content), metadata, identity: "fixture-object", linkCount: 1, executable: metadata.kind === "posix" && (metadata.mode & 0o111) !== 0 }
}
