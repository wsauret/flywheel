export class HandoffError extends Error {}

/** Agent reported `completed` without submitting its handoff.
 *  Classifies as `handoff`: the worker ran but broke the handoff contract. */
export class HandoffNotProducedError extends HandoffError {
  override readonly name = "HandoffNotProducedError";
  constructor(readonly attemptId: string) {
    super(`Worker completed without producing a handoff for attempt ${attemptId}`);
  }
}

/** Submitted handoff content failed schema or mechanical validation. */
export class HandoffInvalidError extends HandoffError {
  override readonly name = "HandoffInvalidError";
  constructor(
    readonly attemptId: string,
    detail: string,
  ) {
    super(`Handoff invalid for attempt ${attemptId}: ${detail}`);
  }
}
