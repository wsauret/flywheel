When I confirm a model or effort change for a global agent role, the first attempt reports a lock error. The lock belongs to Flywheel itself, and the second attempt saves. Please make the first confirmation apply the change.

Fix the shared config ownership boundary, not just the settings caller. An asynchronous config operation must acquire ownership, run its synchronous work, and release ownership without yielding while it holds the lock. Waiting for another owner must remain asynchronous. A synchronous settings write immediately after an asynchronous read must succeed, and the read must still reflect the earlier state.

Keep the existing acquisition retries and protection against other processes. Do not make ownership reentrant for the same process. Release the lock if the operation fails, and return the failure to the caller.

The runtime config owner must publish the new snapshot and notify subscribers only after it releases ownership. Keep those actions together outside the locked work.

Run the relevant tests. Verify the immediate read-then-write sequence and that a failed operation releases ownership before the next write.
