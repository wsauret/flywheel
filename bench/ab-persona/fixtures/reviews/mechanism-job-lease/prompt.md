Verify the behavioral claims that this completed change relies on.

CHANGE:
A worker that crashed used to strand its job in "running" forever. This change gives every claim a lease, makes the worker renew the lease from a heartbeat and abort its handler when a renewal reports the job lost, and adds a reaper that returns jobs with expired leases to the queue. The store runs in the queue service; workers call it over RPC. The change is in diff.patch; the project in this directory is the code after the change.

PROJECT CONTEXT PATHS:
none

ASSIGNED CLAIMS (the domain review tagged these UNVERIFIED; trace each one through the code before you give a verdict):
1. "If a worker's lease lapses (for example, its renewals time out during a network partition) and another worker claims the job, the first heartbeat of the first worker that reaches the store after that claim reports the job lost and aborts its handler, so once the partition heals the two runs overlap by at most one more heartbeat interval."
2. "A job whose worker crashes mid-run is retried, but at most maxAttempts times in total; a job that crashes its worker every time ends as dead."
3. "Two workers that call claim() at the same moment never receive the same job, even though claim reads the queue before it updates it."
4. "The reaper never returns a completed job to the queue, including when the job completes after expiredLeases listed it and before requeueIfExpired runs."
5. "A job whose handler throws cannot be claimed again until its backoff delay has passed."

Return one entry per claim: the claim number, a verdict of confirmed, refuted, or uncertain, the causal trace that settles it, and exact file:line evidence for each decisive step. For an uncertain verdict, name the missing evidence. Do not assign severity and do not write files.
