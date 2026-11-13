# corner-market-loyalty

The loyalty and checkout service of the Corner Market store app. It is deployed as one service; nothing outside this repository imports its modules.

- `src/customers.ts` reads and writes customer records.
- `src/tiers.ts` owns the loyalty tiers: their point thresholds and their discounts.
- `src/checkout.ts` prices an order.
- `src/receipt.ts` renders the plain-text receipt.
- `migrations/` holds the SQL migrations, which the deploy pipeline applies in file-name order.
