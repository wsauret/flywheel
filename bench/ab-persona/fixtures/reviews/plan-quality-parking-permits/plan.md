{
  "schema_version": 1,
  "summary": "Let residents renew a residential parking permit online, as REQUEST.md asks. Phase 1 adds the last-renewal date to the permit record; phase 2 adds the renewal window rule and the renewal route, which charges the zone fee and moves the expiry 12 months on from the old expiry.",
  "context": {
    "key_files": [
      "REQUEST.md - The parking office's request; business permits are out of scope.",
      "src/permits.ts - Permit, the PermitRepo port, and SqlPermitRepo, whose save writes every column of the permit (insert or update).",
      "src/dates.ts - IsoDate, addDays, and addMonths, which clamps a missing day to the month end (2028-02-29 plus 12 months is 2029-02-28).",
      "src/payments.ts - Payments.charge with a reference, PaymentDeclined, and ZONE_FEES.",
      "src/routes.ts - postNewPermit: charges first, then writes the permit, relying on the nightly reconciliation that README.md describes.",
      "migrations/001_permits.sql - The permits table.",
      "tests/sql-permit-repo.test.ts - SqlPermitRepo on SQLite with every migration; tests/memory-permit-repo.ts - MemoryPermitRepo for route tests."
    ],
    "patterns": [
      "SQL lives in SqlPermitRepo and is tested in tests/sql-permit-repo.test.ts; route and rule tests use MemoryPermitRepo.",
      "Charge first, then write, with a reference per charge (README.md, Payments).",
      "Each merge deploys; migrations run before the new build (README.md)."
    ],
    "constraints": [
      "Business permits stay at the town hall (REQUEST.md).",
      "The new expiry is 12 months after the old expiry, also in the grace period.",
      "Each phase is one merge."
    ],
    "project_docs": [
      "README.md",
      "REQUEST.md"
    ]
  },
  "phases": [
    {
      "id": "phase-1",
      "goal": "The permit records its last renewal date.",
      "files": [
        "migrations/002_permit_last_renewed.sql",
        "src/permits.ts",
        "src/routes.ts",
        "tests/sql-permit-repo.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Add migrations/002_permit_last_renewed.sql: `ALTER TABLE permits ADD COLUMN last_renewed_on TEXT;`. NULL means the permit has not been renewed since it was bought. The column is nullable, so the migration needs no backfill and existing rows stay valid.",
          "files": [
            "migrations/002_permit_last_renewed.sql"
          ],
          "test_scenarios": [
            "The SQL repository test applies both migrations to an empty database."
          ]
        },
        {
          "id": "t2",
          "description": "Add `lastRenewedOn: IsoDate | null` to Permit and `last_renewed_on` to PermitRow. Map it in fromRow, and add it to the INSERT column list and the ON CONFLICT update in SqlPermitRepo.save. postNewPermit sets it to null.",
          "files": [
            "src/permits.ts",
            "src/routes.ts",
            "tests/sql-permit-repo.test.ts"
          ],
          "test_scenarios": [
            "A permit saved with lastRenewedOn null reads back null.",
            "Saving the same permit again with lastRenewedOn 2027-06-02 reads back 2027-06-02 and the new expiry."
          ]
        }
      ],
      "verification": "bun test",
      "qualitative_verification": null
    },
    {
      "id": "phase-2",
      "goal": "Residents renew online inside the window.",
      "files": [
        "src/renewals.ts",
        "src/routes.ts",
        "tests/renewals.test.ts",
        "tests/routes.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Add src/renewals.ts with `renewalStatus(permit: Permit, today: IsoDate)`, a pure function returning one of `{ kind: \"town-hall\" }` for a business permit, `{ kind: \"not-yet\"; opensOn }` when today is before `addDays(permit.expiresOn, -30)`, `{ kind: \"lapsed\" }` when today is after `addDays(permit.expiresOn, 14)`, and otherwise `{ kind: \"open\"; newExpiresOn: addMonths(permit.expiresOn, 12) }`. Both window ends are inclusive.",
          "files": [
            "src/renewals.ts",
            "tests/renewals.test.ts"
          ],
          "test_scenarios": [
            "A permit expiring 2027-06-30: on 2027-05-30 not-yet with opensOn 2027-05-31; on 2027-05-31 open; on 2027-07-14 open; on 2027-07-15 lapsed.",
            "Renewed on 2027-07-10, in the grace period, the new expiry is 2028-06-30.",
            "A permit expiring 2028-02-29 renews to 2029-02-28.",
            "A business permit is town-hall on any date."
          ]
        },
        {
          "id": "t2",
          "description": "Add `today: () => IsoDate` (the town's calendar date) to PortalDeps and `postRenewal(deps, session, permitId, { cardToken })` for POST /permits/:permitId/renew. A missing permit or another resident's permit is 404. A status other than open is 409 with a message: not-yet, \"Online renewal opens on <opensOn>.\"; lapsed and town-hall, \"Please renew this permit at the town hall.\" For open, charge `ZONE_FEES[permit.zone]` with reference `permit:<id>:renew:<today>`; PaymentDeclined is 402 and writes nothing. Then save `{ ...permit, expiresOn: newExpiresOn, lastRenewedOn: today }` and return 200 with it.",
          "files": [
            "src/routes.ts",
            "tests/routes.test.ts"
          ],
          "test_scenarios": [
            "An open renewal charges 9000 cents for zone A with the renewal reference and saves the new expiry and lastRenewedOn.",
            "A declined card returns 402 and leaves the permit unchanged.",
            "A not-yet permit returns 409 with the opening date and charges nothing.",
            "A business permit returns 409 with the town-hall message and charges nothing.",
            "Another resident's permit returns 404."
          ]
        }
      ],
      "verification": "bun test",
      "qualitative_verification": "On staging, renew a test permit inside its window and check the clerks' report shows the renewal date."
    }
  ],
  "success_criteria": [
    "A resident can renew a residential permit online from 30 days before expiry to 14 days after.",
    "The new expiry is 12 months after the old one, and the permit records the renewal date.",
    "Business permits are refused online with the town-hall message.",
    "bun test passes."
  ],
  "open_questions": [],
  "implementation_contract": {
    "directives": [
      {
        "id": "d1",
        "text": "Permits store last_renewed_on, read and written by SqlPermitRepo.",
        "completion_check": "tests/sql-permit-repo.test.ts round-trips null and a date."
      },
      {
        "id": "d2",
        "text": "renewalStatus enforces the window and the expiry rule, and postRenewal charges, then saves.",
        "completion_check": "tests/renewals.test.ts covers both window ends, the grace period, and the leap day; tests/routes.test.ts covers success, decline, refusals, and ownership."
      }
    ]
  }
}
