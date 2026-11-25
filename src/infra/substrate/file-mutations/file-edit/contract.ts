/** Shared vocabulary of the pure file edit planners: the bounds every planner
 *  enforces, the byte span it reports, and the one error it refuses with. The
 *  planners never touch the filesystem; they plan against caller-owned text. */

/** A planner refusal the model reads in plain words. */
export class FileEditPlanError extends Error {
  override readonly name = "FileEditPlanError";
}

/** Resource bounds one plan may not exceed. The planners fail closed at every bound. */
export interface FileEditLimits {
  readonly maxPatchBytes: number;
  readonly maxLines: number;
  readonly maxHunks: number;
  readonly maxPathBytes: number;
  readonly maxOutputBytes: number;
}

export const FILE_EDIT_LIMITS: FileEditLimits = {
  maxPatchBytes: 4 * 1024 * 1024,
  maxLines: 100_000,
  maxHunks: 1_000,
  maxPathBytes: 4_096,
  maxOutputBytes: 16 * 1024 * 1024,
};

/** A half-open UTF-8 byte range of the source text one replacement covers. */
export interface ByteSpan {
  readonly start: number;
  readonly end: number;
}

export function limitExceeded(limit: string): FileEditPlanError {
  return new FileEditPlanError(`operation exceeds ${limit} limit`);
}
