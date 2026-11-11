# mechanism-rate-window: claim ground truth (control)

Control fixture: all four claims are true. Claims 1, 3, and 4 look doubtful on a skim. Any refutation is an unsupported finding.

## Claim 1: TRUE (looks doubtful)

Both callers miss `this.windows` and await `hydrate` (limiter.ts:20), which looks like two loads producing two windows. hydrate returns the pending promise when one exists (limiter.ts:30-31), and the first caller registers its promise synchronously before it returns (limiter.ts:32-39). Both callers therefore await the same promise, which resolves to the same array object, the one stored in `windows` (limiter.ts:34-36). After the await each caller runs the prune, the compare, and the push in one synchronous turn (limiter.ts:21-24), and the only later await is the save (limiter.ts:25). The second caller to resume sees the first caller's push and is denied. The probe ran three concurrent first calls against a saved window of 2 with limit 3: results `true,false,false` and one load.

## Claim 2: TRUE

The while loop at limiter.ts:22 removes every timestamp at or before `now - windowMs` before the compare at limiter.ts:23. Timestamps are pushed in clock order (limiter.ts:24), so the oldest is at index 0 and the loop can stop at the first one still inside the window. The probe with limit 2 and window 1000 was denied at 999 and allowed at 1000.

## Claim 3: TRUE (looks doubtful)

A reader may expect the prune to be saved, or the denial to be recorded. The denied path returns false at limiter.ts:23, before the push at limiter.ts:24 and the save at limiter.ts:25. The prune at limiter.ts:22 changes the in-memory array, but it only removes timestamps that no longer count, so it uses no slot. The probe made two denied calls: no store write, and the key was allowed again once the first request left the window.

## Claim 4: TRUE (looks doubtful)

A rejected promise stored in `hydrating` would be returned to every later caller (limiter.ts:30-31). `.finally(() => this.hydrating.delete(key))` (limiter.ts:38) removes the entry when the load rejects as well as when it succeeds, and the `.then` that would fill `windows` (limiter.ts:34-36) does not run on a rejection. The next acquire finds neither a window nor a pending load and calls `store.load` again. The probe failed the first load: the first acquire rejected, the second resolved true, and the store counted 2 loads.
