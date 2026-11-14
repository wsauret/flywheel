# lending-desk

The patron account site of the Millbrook Public Library. Patrons sign in to see their loans and holds. Staff work in the separate circulation terminal, which is not part of this repository.

- `src/loans.ts` holds loans and the LoanStore port.
- `src/holds.ts` holds the holds patrons place on items that are out on loan.
- `src/dates.ts` does calendar arithmetic on ISO dates (`YYYY-MM-DD`).
- `src/web/routes.ts` is the account site's HTTP surface. Every route receives the signed-in patron's id from the session.

The account pages are a separate front end that calls these JSON routes. For each open loan it shows the due date and a Renew button that posts to the loan's renew route, and it displays the message that a refused request returns.

Tests run with `bun test`.
