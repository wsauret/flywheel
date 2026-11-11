# elegance-order-payment-status: seeded defect rationale

## stored-payment-status (types.ts, orders.ts, fulfillment.ts, account-page.ts)

Whether an order is unpaid, partially paid, or paid is a pure function of its lines and payments, and the change even writes that function: `paymentStatusOf` in orders.ts. It then also stores the result on every order as `Order.paymentStatus` and refreshes the copy by hand in `OrderBook.open` and `OrderBook.recordPayment`. Readers (`readyToShip`, `orderLines`) now read the copy instead of the source. This is a status field that shadows derivable state: every future writer of `payments` must remember to refresh it, and nothing ties the two together. Before the change, `readyToShip` derived its answer from `balanceDueCents`; after it, the answer depends on whether the last writer kept the cache current.

The field looks deliberate on a skim: it has a proper union type, it is set at both write sites, and a denormalized status for a dashboard is a common pattern. The `Billable` pick type is introduced only so `paymentStatusOf` can run before the order object exists, which is a small sign that the code is working around its own cache. The elegant shape keeps `Order` as it was and calls `paymentStatusOf(order)` in `readyToShip` and `orderLines`.

Everything else in the change is intended: the label map in account-page.ts is a closed `Record<PaymentStatus, string>`, the dollar formatting is local display code, and the overpayment guard predates the change.
