# plan-quality-timesheet-rounding: seeded defect rationale

## statement-caller-missed (key_files, phase-1/t1, phase-1/t2)

The key_files entry for src/billing/time.ts says "buildInvoice calls it", and phase-1/t1 deletes billableMinutes because "its caller moves to billedTenths in t2". There are two callers. `monthlyStatement` in src/reports/statement.ts imports billableMinutes and sums it to show the month's billed hours, and tests/statement.test.ts covers it. After phase 1 the import does not resolve, so the project stops compiling. Requirement 4 also says the statement and the invoice show the same billed hours, so the statement must move to the same rounded tenths; the plan never names the file. This is a missed caller of a changed API.

## retainer-plan-not-covered (summary, phase-1/t1, phase-1/t2, phase-2/t1)

REQUEST.md requirement 1 starts with "For clients on the standard plan", and requirement 2 says retainer clients keep whole-minute billing because their contract counts minutes against a prepaid block. Requirement 5 limits the note to standard clients' invoices. The plan's `billedTenths(entry)` takes only the entry, `buildInvoice` applies it to every client, and phase-2 adds the note to every invoice. `Client.plan` in src/clients.ts already holds "standard" or "retainer", so the information is there. The plan's summary and constraints restate requirements 1, 3, and 5 and never mention the retainer exception. Retainer clients would be overbilled, so this is a coverage gap.

## What is intended

- Integer tenths with `Math.ceil(minutes / 6)` are correct for "1 to 6 minutes is 0.1 hour", and 0 minutes give 0.
- Keeping two decimals on the invoice ("1.50", "0.20") is a stated constraint that keeps the layout.
- The amount is computed from the same tenths as the hours, so a line's hours and amount agree.
