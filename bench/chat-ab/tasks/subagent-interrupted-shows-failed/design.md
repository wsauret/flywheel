When I interrupt a subagent, the parent lists it as failed even though I can resume it. The same happens when the runtime interrupts it. Please make the parent show interrupted instead, while real failures still show failed.

Carry an interrupted state from the child lifecycle owner through background work tracking into the parent process list. The lifecycle owner knows whether the child was paused, so it must make this decision. Do not just rename the display label or treat every aborted run as interrupted.

An interrupted child is not active work, but its run has not ended. Keep its parent relationship so it can resume, and remove it from the active work count. Keep completion reporting restricted to work that has ended: interruption must neither record a completion nor deliver one to the parent. Preserve the existing behavior for genuine failures and other completed work.

Implement this and run the relevant tests. Verify interruptions by both the person and the runtime, the parent process list, the active work count, and genuine failures.
