# mechanism-session-cache: claim ground truth

Four claims: 1 is false, 2, 3, and 4 are true. Claims 2 and 4 look doubtful on a skim.

## Claim 1: FALSE (label revoke-races-inflight-load)

authorize calls `cache.get(id, () => this.store.find(id))` (sessions.ts:27). On a miss, get starts loadAndStore and records it in `inflight` (cache.ts:27-28); loadAndStore awaits the load (cache.ts:39). If the store read the row before revoke's `markRevoked` (sessions.ts:35) committed, the load resolves with `revoked: false`. revoke then calls `invalidate` (sessions.ts:36), which deletes the entry, of which there is none yet, and increments the generation (cache.ts:32-34). It does not touch `inflight`. Two things then go wrong:

- A request that arrives after revoke resolves but before the load finishes finds `inflight` (cache.ts:25-26) and receives the stale session.
- When the load finishes, cache.ts:40 stores the stale session with `generation: this.generationOf(key)`, read after the await, so it records the new generation instead of the generation the load started under. get never compares generations in any case (cache.ts:22-24). Every authorize for the next 60 seconds (sessions.ts:4) is served the non-revoked copy.

The comment at cache.ts:9-11 describes the guard the claim relies on, but the code does not implement it. The probe started an authorize with a 30 ms store read, revoked after 5 ms, and got the session back both during the load and after it.

## Claim 2: TRUE (looks doubtful)

`this.loadAndStore(key, load)` (cache.ts:27) runs synchronously until its first await, `await load()` (cache.ts:39), and then returns the promise. `this.inflight.set` (cache.ts:28) runs next in the same synchronous turn. No other caller of get can run between those lines, because JavaScript runs one synchronous turn at a time. The finally that deletes the inflight entry (cache.ts:42-43) runs only after the load settles. The probe made three concurrent authorize calls and the store saw one find.

## Claim 3: TRUE

The only path that returns a cached value is cache.ts:23-24, and it requires `hit.expiresAt > this.clock.now()`. expiresAt is set to `clock.now() + ttlMs` when the value is stored (cache.ts:40). The probe with TTL 100 served the hit at +99 and reloaded at +100.

## Claim 4: TRUE (looks doubtful)

A reader may expect the rejected promise to stay in `inflight`. When `load()` rejects, cache.ts:40 is skipped, so no entry is stored, and the finally at cache.ts:42-43 deletes the inflight entry before the rejection reaches callers. The next get finds neither an entry nor an inflight promise and starts a new load. The probe failed the first find and the second authorize queried the store again and returned the session.
