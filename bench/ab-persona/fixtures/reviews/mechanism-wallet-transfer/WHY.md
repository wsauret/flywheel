# mechanism-wallet-transfer: claim ground truth

Plan review. Five claims: 1 and 2 are false, 3, 4, and 5 are true. Claims 3 and 4 look doubtful on a skim.

## Claim 1: FALSE (label apply-not-atomic-on-insufficient-funds)

apply has a validation pass (ledger.ts:25-31) that checks the sum, the amounts, that each account exists, and the currencies. That pass makes the method look validate-then-apply. The funds check is not in it. It lives in `AccountBook.debit` (accounts.ts:43-47), which the mutation loop calls (ledger.ts:32-36). When a debit throws InsufficientFunds, the credits and debits applied earlier in that loop stay applied, and nothing reverts them. With the plan's order (credit `to`, credit fees, debit `from`), a transfer the sender cannot cover credits the recipient and the fee account and then throws, which creates money. The probe gave alice 100 and posted the plan's entry for 500 plus 25: InsufficientFunds, and the balances were alice 100, bob 500, fees 25.

## Claim 2: FALSE (label snapshot-every-fifty-entries)

The only persistence call in apply is `this.persistence.recordApplied()` (ledger.ts:37). recordApplied increments a counter and returns until the counter reaches SNAPSHOT_EVERY = 50 (persistence.ts:4, persistence.ts:32-34). On the 50th entry it only schedules the write on `this.writing` (persistence.ts:38-39). `post` calls the synchronous `apply` and resolves (service.ts:14-16) without awaiting `flushed()`. There is no journal. A crash loses every entry since the last completed snapshot. The probe posted two entries and found no snapshot file on disk. The snapshot path is otherwise sound, so a review that traces it finds nothing else to report: load treats only a missing file as a new book and rethrows every other read error (persistence.ts:20-29), and a failed snapshot write does not block the next one, because the chain runs the next write on rejection too (persistence.ts:37-39).

## Claim 3: TRUE (looks doubtful)

The sign conventions make this look fragile. Only `debit` lowers a balance (accounts.ts:43-47; credit only adds, accounts.ts:50-52), and apply routes every negative posting to debit with the positive amount (ledger.ts:34). debit throws when `balance - amount < -overdraftLimit` (accounts.ts:44), which for limit 0 is any result below zero. Each debit checks the balance as it is at that moment, so a second debit of the same account in one entry sees the first one. The probe debited an account holding 100 twice by 60 in one entry: the second debit threw and the balance stayed at 40, never below 0. (The entry was left half-applied, which is claim 1's defect, not a negative balance.)

## Claim 4: TRUE (looks doubtful)

ledger.ts passes the raw `posting.accountId` to the book (ledger.ts:29, ledger.ts:33), which suggests that ids are not normalized. `AccountBook.get` normalizes inside (accounts.ts:28-29), and so do `open` (accounts.ts:22) and `restore` (accounts.ts:40), with `normalizeId` doing trim plus lower case (accounts.ts:14-16). Every path where an id enters the book normalizes it. The probe posted to `" Bob"` and the account opened as `bob` was credited.

## Claim 5: TRUE

The currency check is in the validation pass (ledger.ts:30), which runs over all postings before the mutation loop starts (ledger.ts:32). The probe posted a usd entry that touched a eur account: InvalidEntry, with both balances unchanged.
