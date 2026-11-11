# mechanism-flag-rollout: claim ground truth (control)

Control fixture: all four claims are true. Claims 1, 3, and 4 look doubtful on a skim. Any refutation is an unsupported finding.

## Claim 1: TRUE (looks doubtful)

A reader may suspect that the hash is signed, so that `% 100` gives negative buckets, or that the bucket depends on the percentage. The bucket is the FNV-1a hash of the string `flagKey:userId`, modulo 100 (flags.ts:5-6). It depends only on the flag key and the user id, not on rolloutPercent or the revision. fnv1a32 ends with `hash >>> 0` (hash.ts:8), so it returns an unsigned 32-bit integer and the bucket is in 0 to 99. evaluate turns the flag on when `bucket < rolloutPercent` (flags.ts:22). A user with a bucket below 10 has a bucket below 20. The probe evaluated 20,000 users: 2,023 were on at 10%, none of them was off at 20%, and the buckets ranged from 0 to 99.

## Claim 2: TRUE

refresh catches a fetch failure, reports it to onError, and returns false (flags.ts:30-34) before it reaches the assignment at flags.ts:37. `this.snapshot` keeps the last good set, and evaluate reads it (flags.ts:19). http-flags.ts rejects a non-2xx status or a malformed body (http-flags.ts:8-12), so those cases take the same catch. The probe failed the second refresh and the flag stayed on.

## Claim 3: TRUE (looks doubtful)

Overlapping awaits look like a lost-update race. The revision comparison runs after the await, against the snapshot as it is when that response arrives (flags.ts:36). If the newer response lands first, the older one fails `next.revision <= this.snapshot.revision` and is dropped. If the older one lands first, the newer one replaces it. Revisions only increase (types.ts:8). The probe made the older response (revision 7) arrive 35 ms after the newer one (revision 8); results were `false,true` and the client kept revision 8.

## Claim 4: TRUE (looks doubtful)

evaluate is a synchronous method that returns a boolean and reads only `this.snapshot` (flags.ts:18-23); it never calls fetchFlags. The initial snapshot has no flags (flags.ts:10), and the lookup reads only own keys of the flag map (flags.ts:19), so before the first refresh assigns one, every lookup is undefined, also for a key such as `toString` that names an inherited member, and returns the fallback (flags.ts:20). The probe called evaluate while the first fetch was still pending and got the fallback `true` back synchronously.
