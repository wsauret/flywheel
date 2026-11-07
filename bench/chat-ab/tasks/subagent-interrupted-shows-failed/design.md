When the runtime interrupts a subagent, the parent keeps waiting on it and cannot hand off, and the subagent's record says "stopped" even though it can resume. Please make the record say interrupted, release the parent from a subagent that the runtime interrupted, and keep a subagent that I interrupted as the parent's work. Real failures must still record as failed.

Carry an interrupted state, with who interrupted the child, from the child lifecycle owner through background work tracking into the parent's records. The lifecycle owner knows whether and by whom the child was paused, so it must make this decision. Do not just relabel the record or treat every aborted run as interrupted.

An interrupted child's run has not ended. Keep its parent relationship so it can resume. A child that the runtime or its parent agent interrupted is not the parent's outstanding work, so no wait parks on it and it blocks no handoff, and the parent is told that the runtime interrupted it. A child that a person interrupted stays the parent's outstanding work and sends no notice. Interruption must neither record a completion nor deliver one to the parent. Preserve the existing behavior for genuine failures and other completed work.

Implement this and run the relevant tests. Verify interruptions by both the person and the runtime, the parent's records, its outstanding work, and genuine failures.
