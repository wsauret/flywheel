import { createHash } from "node:crypto";
import type { AsyncEventStateReadSurface } from "../../../../infra/event-store-types.js";
import { readToolExecution } from "../../../session/tool-execution-projection.js";
import type { ToolOutputOwners } from "../../llm/types.js";

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

/**
 * The owners of the tool output of a run's requests (`StreamOptions.executionCwd`, `artifactScopeId`,
 * `savedOutputPath`). A call's recorded result is the one record of the file that its cut saved
 * (`ToolOutputRecovery.fullContentPath`), so the lookup reads that record by the call's id. A run with no durable
 * session has no record, and its lookup is absent.
 */
export function toolOutputOwners(run: {
  readonly executionCwd: string;
  readonly artifactScopeId: string;
  readonly sessionId?: string | undefined;
  readonly sessionEventReader?: AsyncEventStateReadSurface | undefined;
}): ToolOutputOwners {
  const { sessionEventReader: reader, sessionId } = run;
  return {
    executionCwd: run.executionCwd,
    artifactScopeId: run.artifactScopeId,
    ...(reader === undefined || sessionId === undefined ? {} : {
      savedOutputPath: async (toolUseId: string) => (await readToolExecution(reader, sessionId, toolUseId))?.fullContentPath,
    }),
  };
}
