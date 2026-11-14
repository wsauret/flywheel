# till-service

The point-of-sale backend of the Paper Lantern bookshops. The till app at each counter calls its HTTP routes.

- `src/sales.ts` holds sales and the refunds recorded against them.
- `src/payments/` refunds card payments through the card gateway.
- `src/giftcards/` issues and loads gift cards.
- `src/customers/credit.ts` keeps the store credit balance of a customer account.
- `src/till/routes.ts` is the HTTP surface of the till app.
- `src/jobs/returns-import.ts` is the nightly job that refunds the returns customers registered in the web shop.

Tests run with `bun test`.
