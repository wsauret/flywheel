# billing-ledger: seeded defect rationale

## reconcile-float-equality (reconcile.ts)

statementTotalDollars sums `entry.settledCents / 100` as doubles. Values like 10.10 and 30.30 are not representable in binary floating point, and the sum of the nearest doubles is generally not the nearest double of the true sum, so after a handful of entries the accumulated total differs from `processorBalanceCents / 100` in the last bits. Because reconcile uses `!==` instead of comparing integer cents (or an epsilon), statements whose cent totals agree exactly still page the finance on-call.

## idempotency-key-collision (billing.ts)

idempotencyKeyFor hashes customerId, currency, subtotal, and the UTC day bucket; `request.requestId` exists precisely to distinguish retries from new purchases but is never used. A customer who buys the same item twice in one day produces the same key both times, so charge() returns the first ledger entry and the second purchase is never charged. The comment about "stable across client retries" makes the key look intentional on a skim.

## refund-double-fee (billing.ts)

charge() stores `grossCents = applyProcessingFee(breakdown.totalCents)`, so grossCents is already fee-inclusive. refund() then computes `applyProcessingFee(charge.grossCents)`, grossing up the fee-inclusive amount a second time. Every full refund returns roughly 2.9% more than the customer paid. The function is correct in isolation; the defect is the second application along the refund call path.

## refund-fx-timing (billing.ts)

charge() captures `fxRate` at posting time and stores it on the entry. refund() ignores the stored rate and reads `rates.current(charge.currency)` at refund time. If the rate drifted between charge and refund, `settledCents` of the refund does not mirror the charge, so charge+refund pairs fail to net to zero in USD and the books drift by the FX movement.

## discount-tax-ordering (billing.ts)

In computeTotal, the percent branch discounts first and taxes the discounted amount; the fixed branch computes tax on the full subtotal and subtracts the discount from the taxed total. The tax base is inconsistent between the two promo kinds: a $10 fixed discount still pays tax on the $10, while an equivalent percent discount does not. Fixed-promo customers are overtaxed by `TAX_RATE * discountCents`.
