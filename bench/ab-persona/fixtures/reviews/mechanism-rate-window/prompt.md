Verify the behavioral claims that this completed change relies on.

CHANGE:
The sliding-window rate limiter used to keep its windows in memory only, so a deploy reset every client's budget. This change loads each key's window from the key-value service on its first use after a restart and saves the window after every allowed request (limiter.ts, kv-window-store.ts). acquire becomes async. The change is in diff.patch; the project in this directory is the code after the change.

PROJECT CONTEXT PATHS:
none

ASSIGNED CLAIMS (the domain review tagged these UNVERIFIED; trace each one through the code before you give a verdict):
1. "Two concurrent acquire calls for a key that has not been used since the restart, whose saved window has one slot left, cannot both take that slot, although both find the key missing and both await hydrate."
2. "Timestamps that have left the window are dropped before the count is compared, so a key regains its slots as old requests age out, without any timer."
3. "A denied request neither consumes a slot nor causes a store write."
4. "A failed load is not cached: the next acquire for that key loads the window again instead of receiving the same rejection."

Return one entry per claim: the claim number, a verdict of confirmed, refuted, or uncertain, the causal trace that settles it, and exact file:line evidence for each decisive step. For an uncertain verdict, name the missing evidence. Do not assign severity and do not write files.
