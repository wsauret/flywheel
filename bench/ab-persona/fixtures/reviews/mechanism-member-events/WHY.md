# mechanism-member-events: claim ground truth

Four claims: 1 is false, 2, 3, and 4 are true. Claims 2 and 4 look doubtful on a skim.

## Claim 1: FALSE (label notification-before-commit)

addMember calls `this.bus.emit(...)` as the last statement of the transaction callback (membership.ts:13-16). Database.transaction awaits the callback and only then sends COMMIT (db.ts:23-24). emit puts each listener on a microtask (bus.ts:16-18). The comment at bus.ts:7-8 suggests that the event waits, but a microtask runs as soon as the current synchronous turn ends, at the first await, which is long before the COMMIT round trip resolves. The notifier listener then sends the event to every socket of the team (notifier.ts:10-12). Clients therefore see member.added before the row is committed. A client that refetches the roster at once can miss the new member. If COMMIT throws, transaction rolls back and rethrows (db.ts:26-28), but the notification has already been sent for a member that does not exist. The probe recorded `socket member.added > sql COMMIT start > sql COMMIT failed > sql ROLLBACK`. removeMember emits after the transaction resolves (membership.ts:29-30), so only the add path has this defect.

## Claim 2: TRUE (looks doubtful)

record chains each append on the previous tail for the team: `previous.then(() => this.sink.append(...))` (audit.ts:13-14). A later append cannot start until the earlier one settles, whatever their durations. The stored tail is `next.catch(() => undefined)` (audit.ts:15), so a rejected append resolves the tail and the next append still runs, while the caller of the failed record still receives the rejection through `next` (audit.ts:16). The probe made a slow first append, a failing second, and a fast third; the sink received `first` and then `third`.

## Claim 3: TRUE

In addMember the audit call follows `await this.db.transaction(...)` (membership.ts:13-18). When the transaction rejects, after the callback throws or after COMMIT fails (db.ts:26-28), the await throws and membership.ts:18 does not run. removeMember has the same order (membership.ts:23-31). The probe failed the commit and recorded 0 audit entries.

## Claim 4: TRUE (looks doubtful)

The transaction callback returns false when the DELETE affects no rows (membership.ts:24-25), and transaction returns that value after COMMIT (db.ts:23-25). removeMember then returns at membership.ts:29, before the emit at membership.ts:30 and the audit at membership.ts:31. The probe removed a non-member: result false, no socket message, no audit entry.
