# plan-elegance-session-expiry: control

This fixture seeds no defect. It is a clean plan that contains choices a reflexive structural reviewer tends to flag. Each is correct here.

## Tempting findings that are wrong

- "expiresAt is a stored value that could be derived from createdAt and the TTL." It cannot be derived under the stated constraint: the security team requires that a session keep the lifetime it was issued with, so deriving from the current constants would change existing sessions whenever a constant changes. The issued expiry is a fact of its own, stored once. The plan stores it instead of a `remember` flag, so no expiry check needs to know the lifetime table.
- "createdAt and expiresAt are two sources of truth." They are two different facts: the account page shows when a session signed in, and every expiry check reads only expiresAt.
- "The backfill migration is a compatibility path." Existing rows are real data and the column is NOT NULL; the backfill gives each one the 12-hour lifetime it was issued with, which the constraint requires.
- "isExpired is a one-line wrapper." It is the module's expiry rule with two callers (requireSession and activeSessions); keeping it is what lets the plan change the rule without touching them.
- "Renaming deleteCreatedBefore breaks callers." sweepSessions is its only caller, and the plan updates it in the same task; no alias is kept.
- "Max-Age is a second expiry." It is the browser's cookie lifetime, which a remembered session needs to survive a restart; the server still decides validity from expiresAt.
