Verify the behavioral claims that this completed change relies on.

CHANGE:
The order service used to keep orders in memory only. This change adds an append-only journal (journal.ts, file-journal.ts), makes createOrder resolve only after its record is journaled, rebuilds state from the journal at startup (OrderService.recover), and deduplicates client retries by requestId. The change is in diff.patch; the project in this directory is the code after the change.

PROJECT CONTEXT PATHS:
none

ASSIGNED CLAIMS (the domain review tagged these UNVERIFIED; trace each one through the code before you give a verdict):
1. "If the journal write or sync fails, createOrder rejects, so the caller never receives a 201 for an order that is not on disk."
2. "When createOrder appends while an earlier flush is still running, its promise does not resolve when that earlier batch finishes; on the success path it resolves only after its own record has been written and synced."
3. "A client retry with the same requestId, for example one sent after a client-side timeout, never appends a second journal record and never creates a second order id."
4. "Two concurrent createOrder calls with different requestIds never receive the same order id, even though createOrder awaits the journal."
5. "After recover() replays the journal, the next order id is greater than every order id in the journal, whatever order the records were written in."

Return one entry per claim: the claim number, a verdict of confirmed, refuted, or uncertain, the causal trace that settles it, and exact file:line evidence for each decisive step. For an uncertain verdict, name the missing evidence. Do not assign severity and do not write files.
