# plan-quality-library-renewals: control

This fixture seeds no defect. The plan is complete and every claim it makes about the code holds. It contains choices that a reflexive plan reviewer tends to flag; each is correct here.

## Tempting findings that are wrong

- "isOnHold counts expired holds, so a lapsed hold blocks renewal." It does not: isOnHold filters through activeHolds, which keeps only holds whose expiresOn is today or later, and tests/holds.test.ts asserts that a hold stops counting the day after expiresOn. The plan's claim in key_files is accurate.
- "Comparing dueOn and today as strings is a bug." Both are IsoDate values in the fixed-width YYYY-MM-DD form, which src/dates.ts documents, so string order is date order.
- "The new due date should count from today." REQUEST.md rule 5 says the opposite in so many words: from the current due date, so renewing early never shortens a loan.
- "A loan due today should count as overdue" or the reverse. The plan states the choice (due today is not overdue) and tests both sides of the boundary; it matches the ordinary meaning of a due date.
- "The renewal limit ignores desk renewals" or "counts them wrongly". Loan.renewals already counts desk and online renewals, and the request limits renewals of the loan; the plan states this as a constraint.
- "There is no confirmation email" or "the circulation terminal is not updated." Both are out of scope by the request's own words.
- "today is computed in the server's zone." The route uses todayIn(LIBRARY_TIME_ZONE, now), and a test pins the case where UTC and the library's zone are on different dates. todayIn's en-CA format really produces YYYY-MM-DD, and tests/dates.test.ts asserts it.
- "Two quick clicks, or a second request after the first one saved, can renew twice." The page posts the due date it showed, and renewLoan refuses with already-renewed when the loan's due date has moved on, so a repeated request changes nothing; the plan tests this in renewLoan and in the route. When both requests read the loan before either saves, both write the same new due date and count, so the result is still one renewal. No lock is needed.
- "The plan adds no Renew button and does not show the refusal message." README.md says the account pages are a separate front end that calls these JSON routes, shows a Renew button for each open loan, and displays the message a refusal returns. This repository serves only the routes, so the route and its messages are the whole change here.
- "Another patron's loan should return 403." Returning not-found is deliberate and stated: it does not tell a patron that the loan id exists.
- "The tests are thin." There is one scenario per rule, including both sides of the overdue and limit boundaries and the lapsed-hold case; that covers every requirement.
