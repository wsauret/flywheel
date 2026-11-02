import { createHash } from "node:crypto";

export interface ToolOutputRecovery {
  contentTruncated: boolean;
  originalContentBytes: number;
  originalContentSha256: string;
  semanticOutputTruncated: boolean;
  byteOutputTruncated: boolean;
  fullContentPath?: string;
}

interface LimitedOutputMetadata {
  semanticTruncated: boolean;
  byteTruncated: boolean;
  fullContentPath?: string;
}

/** The measured size and digest of an original tool payload. */
interface OriginalContentEvidence {
  readonly bytes: number;
  readonly sha256: string;
}

/** Measures an original payload held in memory as its UTF-8 bytes. */
export function measureOriginalContent(content: string): OriginalContentEvidence {
  return { bytes: Buffer.byteLength(content, "utf8"), sha256: createHash("sha256").update(content).digest("hex") };
}

export function createToolOutputRecovery(
  original: OriginalContentEvidence,
  limited: LimitedOutputMetadata,
): ToolOutputRecovery {
  return {
    contentTruncated: true,
    originalContentBytes: original.bytes,
    originalContentSha256: original.sha256,
    semanticOutputTruncated: limited.semanticTruncated,
    byteOutputTruncated: limited.byteTruncated,
    ...(limited.fullContentPath ? { fullContentPath: limited.fullContentPath } : {}),
  };
}
