Verify the behavioral claims that this completed change relies on.

CHANGE:
Every authenticated request used to read its session row from the database. This change puts a read-through cache with a 60-second TTL in front of the session store (cache.ts) and makes SessionAuth.revoke invalidate the cached entry. The change is in diff.patch; the project in this directory is the code after the change.

PROJECT CONTEXT PATHS:
none

ASSIGNED CLAIMS (the security review accepted the cache on the strength of these; trace each one through the code before you give a verdict):
1. "Once revoke(id) resolves, no later authorize call can return that session, including when an authorize call for the same session was already waiting on the store when revoke ran."
2. "Concurrent cache misses for one session id call store.find only once. The inflight entry is registered after loadAndStore has been called, but no other caller can run in between."
3. "A cached session is never served past the TTL: every hit compares the entry's expiry with the injected clock."
4. "When store.find rejects, nothing is cached: the next authorize call for that session queries the store again instead of receiving the same rejected promise."

Return one entry per claim: the claim number, a verdict of confirmed, refuted, or uncertain, the causal trace that settles it, and exact file:line evidence for each decisive step. For an uncertain verdict, name the missing evidence. Do not assign severity and do not write files.
