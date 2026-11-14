{
  "schema_version": 1,
  "summary": "Let patrons renew a loan from their account page, as REQUEST.md asks. One function applies the five renewal rules and returns either the renewed loan or the reason for a refusal; one route exposes it and turns each reason into the sentence the page shows.",
  "context": {
    "key_files": [
      "REQUEST.md - The head of lending's request, with the five rules and what is out of scope.",
      "src/loans.ts - Loan (dueOn, renewals, returnedOn) and the LoanStore port.",
      "src/holds.ts - isOnHold(store, itemId, today), which counts only holds still waiting today: activeHolds drops a hold once its expiresOn has passed.",
      "src/dates.ts - IsoDate, addDays, and todayIn. ISO dates compare correctly as strings because the format is fixed-width.",
      "src/config.ts - LIBRARY_TIME_ZONE, the zone of every due date.",
      "src/web/routes.ts - The account routes; each receives the signed-in patron's id in Session.",
      "tests/fakes.ts - memoryLoans and memoryHolds."
    ],
    "patterns": [
      "Routes take their stores and the Session; tests call them with memory stores.",
      "Dates are IsoDate strings, computed with src/dates.ts."
    ],
    "constraints": [
      "A renewal moves dueOn 14 days on from the current dueOn, not from today (REQUEST.md rule 5).",
      "Out of scope: a confirmation email and the circulation terminal (REQUEST.md).",
      "The renewal count includes desk renewals: Loan.renewals already counts both, so the limit of two applies to the loan, not to online renewals only."
    ],
    "project_docs": [
      "README.md",
      "REQUEST.md"
    ]
  },
  "phases": [
    {
      "id": "phase-1",
      "goal": "The renewal rules in one function.",
      "files": [
        "src/renewals.ts",
        "tests/renewals.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Add src/renewals.ts with `renewLoan(deps: { loans: LoanStore; holds: HoldStore }, patronId: string, loanId: string, shownDueOn: IsoDate, today: IsoDate): Promise<RenewalResult>`, where `RenewalResult = { ok: true; loan: Loan } | { ok: false; reason: \"not-found\" | \"returned\" | \"already-renewed\" | \"limit\" | \"overdue\" | \"on-hold\" }`. shownDueOn is the due date the page showed when the patron pressed Renew. Check in this order: a missing loan or a loan of another patron is not-found, so a patron cannot learn about another patron's loans; returnedOn set is returned; `loan.dueOn !== shownDueOn` is already-renewed, so a repeated or late second request for the same renewal changes nothing; renewals >= 2 is limit; `loan.dueOn < today` is overdue (a loan due today is not overdue); isOnHold(deps.holds, loan.itemId, today) is on-hold. Otherwise save and return `{ ...loan, dueOn: addDays(loan.dueOn, 14), renewals: loan.renewals + 1 }`.",
          "files": [
            "src/renewals.ts",
            "tests/renewals.test.ts"
          ],
          "test_scenarios": [
            "A loan due 2027-05-20 with one renewal, renewed on 2027-05-12, is due 2027-06-03 with two renewals, and the store holds the new loan.",
            "A loan with two renewals is refused with limit and is not saved.",
            "A loan due 2027-05-11 renewed on 2027-05-12 is refused with overdue; the same loan renewed on 2027-05-11 succeeds.",
            "A loan whose item has a waiting hold is refused with on-hold; with only a lapsed hold it succeeds.",
            "A returned loan is refused with returned.",
            "Renewing the loan due 2027-05-20 with shownDueOn 2027-05-20 succeeds; a second call with the same shownDueOn is refused with already-renewed, and the store still holds due 2027-06-03 with two renewals.",
            "Another patron's loan and an unknown loan id are both refused with not-found."
          ]
        }
      ],
      "verification": "bun test tests/renewals.test.ts",
      "qualitative_verification": null
    },
    {
      "id": "phase-2",
      "goal": "Patrons renew from the account page.",
      "files": [
        "src/web/routes.ts",
        "tests/routes.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Add `postRenewal(deps, session, loanId, body, now = new Date())` for POST /account/loans/:loanId/renew, with body `{ dueOn }`: the due date the account page showed for the loan. A body without a string dueOn is 400. It computes today with `todayIn(LIBRARY_TIME_ZONE, now)` and calls renewLoan with session.patronId and body.dueOn. A renewed loan is 200 with the loan. not-found is 404. Every other reason is 409 with `{ reason, message }`, where the message is: returned, \"This loan is already returned.\"; already-renewed, \"This loan was already renewed.\"; limit, \"This loan has been renewed twice, which is the limit.\"; overdue, \"This loan is overdue. Please renew it at the desk.\"; on-hold, \"Another reader is waiting for this item, so it cannot be renewed.\"",
          "files": [
            "src/web/routes.ts",
            "tests/routes.test.ts"
          ],
          "test_scenarios": [
            "A renewable loan returns 200 with the new due date.",
            "A loan on hold returns 409 with reason on-hold and its message.",
            "Another patron's loan returns 404.",
            "Posting the same renewal twice returns 200, then 409 with reason already-renewed and its message.",
            "A body without dueOn returns 400.",
            "At 03:00 UTC on 2027-05-11, a loan due 2027-05-10 is not yet overdue, because it is still 2027-05-10 in the library's zone."
          ]
        }
      ],
      "verification": "bun test",
      "qualitative_verification": "Sign in as a test patron on the staging site, renew one loan, and try a loan with a waiting hold."
    }
  ],
  "success_criteria": [
    "A patron can renew an own open loan online within the five rules of REQUEST.md.",
    "Each refusal shows one sentence that gives the reason.",
    "bun test passes."
  ],
  "open_questions": [],
  "implementation_contract": {
    "directives": [
      {
        "id": "d1",
        "text": "renewLoan enforces every rule of REQUEST.md and moves the due date from the current due date.",
        "completion_check": "tests/renewals.test.ts has a scenario for each rule."
      },
      {
        "id": "d2",
        "text": "POST /account/loans/:loanId/renew returns the renewed loan or the refusal sentence.",
        "completion_check": "tests/routes.test.ts covers success, a refusal, a repeated request, another patron's loan, and the library-zone date."
      }
    ]
  }
}
