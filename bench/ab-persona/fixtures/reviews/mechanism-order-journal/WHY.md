# mechanism-order-journal: claim ground truth

Five claims: 1 and 3 are false, 2, 4, and 5 are true. Claims 2 and 4 look doubtful on a skim and are there to penalize a reviewer who refutes by reflex.

## Claim 1: FALSE (label journal-failure-still-acknowledged)

createOrder awaits `this.journal.append(record)` (orders.ts:30). append returns `this.flushing`, the promise of `drain()` (journal.ts:17-18). drain wraps the write and sync loop in try/catch (journal.ts:32-43); the catch at journal.ts:38-40 clears pending and calls `onError(error)`, then returns without rethrowing. An async function that returns normally fulfills its promise, so the await in createOrder completes, `remember` records the order, and the handler in server.ts:12 answers 201. The only error path is the `console.error` callback wired in server.ts:7-9. The doc comment "Resolves once the record has been written and synced" at journal.ts:14 is what makes the claim look true.

## Claim 2: TRUE (looks doubtful)

A reader sees `this.flushing ??= this.drain(); return this.flushing;` (journal.ts:17-18) and suspects that a second append receives the promise of a batch that does not contain its record. It does receive the same promise, but that promise belongs to the whole drain loop, not to one batch: `while (this.pending.length > 0)` (journal.ts:33) takes the next batch after each sync, and the record pushed at journal.ts:16 during the first write is in `pending` when the loop checks again. The loop exits only when pending is empty, and there is no await between the final loop check and `this.flushing = undefined` in finally (journal.ts:42), so no append can slip in between. On the success path the promise resolves only after the later record is written and synced. The probe recorded `write 1, sync, write 1, sync` and found the second record synced when its promise resolved.

## Claim 3: FALSE (label concurrent-retry-duplicates-order)

The dedupe check is `findExisting(request.requestId)` (orders.ts:21), which reads `byRequest` (orders.ts:35). `byRequest.set` happens only in `remember` (orders.ts:40), and createOrder calls remember after `await this.journal.append(record)` (orders.ts:30-31). A retry that arrives during that await, which is exactly when a client times out and resends, finds nothing, takes the next sequence number (orders.ts:24), and appends a second record. The probe ran two concurrent calls with one requestId and got `ord-1` and `ord-2` with two journal lines.

## Claim 4: TRUE (looks doubtful)

The await at orders.ts:30 suggests a race on the sequence, but `this.nextSeq++` runs inside the object literal at orders.ts:24, synchronously, before the await. Each concurrent call increments the counter before it yields. remember only raises nextSeq (orders.ts:42), never lowers it. The probe got `ord-1` to `ord-4` for four concurrent calls.

## Claim 5: TRUE

recover() calls remember for every replayed record (orders.ts:15). remember parses the sequence from the id and sets `nextSeq = seq + 1` whenever `seq >= nextSeq` (orders.ts:41-42), so after the loop nextSeq is one past the maximum, independent of record order. The probe replayed `ord-3, ord-11, ord-7` and the next order was `ord-12`.

## Intended behavior outside the claims

replay throws on a line that is not a whole record, including a last line cut short by a crash (journal.ts:21-28), so startOrders does not start until an operator repairs the journal. The comment at journal.ts:21-22 states this fail-stop choice. It is not a labeled defect; a review that reports it as a bug contradicts the documented design and the finding counts as unsupported.
