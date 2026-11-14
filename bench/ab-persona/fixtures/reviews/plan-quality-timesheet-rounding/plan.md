{
  "schema_version": 1,
  "summary": "Bill time in 6-minute increments rounded up, as REQUEST.md asks. The billed time of an entry becomes a whole number of tenths of an hour, computed in one function, so the hours and the amount on each invoice line come from the same rounded value. Invoices carry the increment note.",
  "context": {
    "key_files": [
      "REQUEST.md - The finance lead's request.",
      "src/billing/time.ts - billableMinutes(entry): all minutes of a billable entry, zero otherwise. buildInvoice calls it for each line.",
      "src/billing/invoice.ts - buildInvoice: one line per entry with hours (two decimals) and amountCents, the total, and an empty notes list.",
      "src/clients.ts - Client and its hourly rate in cents.",
      "src/entries.ts - TimeEntry with whole minutes and the billable flag.",
      "tests/invoice.test.ts - Existing invoice coverage."
    ],
    "patterns": [
      "Money is integer cents, rounded once per invoice line.",
      "Billing rules live in src/billing/time.ts; documents only format them."
    ],
    "constraints": [
      "Non-billable entries stay at zero.",
      "Invoice hours keep two decimals, so the invoice layout does not change.",
      "Rates do not change."
    ],
    "project_docs": [
      "README.md",
      "REQUEST.md"
    ]
  },
  "phases": [
    {
      "id": "phase-1",
      "goal": "Each entry is billed in whole tenths of an hour, rounded up.",
      "files": [
        "src/billing/time.ts",
        "src/billing/invoice.ts",
        "tests/time.test.ts",
        "tests/invoice.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Replace billableMinutes in src/billing/time.ts with `billedTenths(entry: TimeEntry): number`, which returns `Math.ceil(entry.minutes / 6)` for a billable entry and 0 otherwise. Integer tenths keep the arithmetic exact. Delete billableMinutes; its caller moves to billedTenths in t2.",
          "files": [
            "src/billing/time.ts",
            "tests/time.test.ts"
          ],
          "test_scenarios": [
            "1 and 6 minutes give 1 tenth; 7 minutes give 2; 60 minutes give 10; 90 minutes give 15.",
            "0 minutes give 0.",
            "A non-billable entry of 45 minutes gives 0."
          ]
        },
        {
          "id": "t2",
          "description": "In buildInvoice, compute `const tenths = billedTenths(entry)`, show `hours: (tenths / 10).toFixed(2)`, and bill `amountCents: Math.round((tenths * client.hourlyRateCents) / 10)`.",
          "files": [
            "src/billing/invoice.ts",
            "tests/invoice.test.ts"
          ],
          "test_scenarios": [
            "A 90-minute entry at 120.00 per hour shows 1.50 hours and bills 18000 cents (unchanged).",
            "A 7-minute entry shows 0.20 hours and bills 2400 cents.",
            "A non-billable entry shows 0.00 and bills 0.",
            "The total is the sum of the line amounts."
          ]
        }
      ],
      "verification": "bun test tests/time.test.ts tests/invoice.test.ts",
      "qualitative_verification": null
    },
    {
      "id": "phase-2",
      "goal": "Invoices state the increment rule.",
      "files": [
        "src/billing/invoice.ts",
        "tests/invoice.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Set the invoice notes to `[\"Time is billed in 6-minute increments, rounded up.\"]`.",
          "files": [
            "src/billing/invoice.ts",
            "tests/invoice.test.ts"
          ],
          "test_scenarios": [
            "A built invoice carries exactly the increment note."
          ]
        }
      ],
      "verification": "bun test",
      "qualitative_verification": null
    }
  ],
  "success_criteria": [
    "Billable entries are billed in 6-minute increments, rounded up, in hours and in amount.",
    "Non-billable entries bill nothing.",
    "Invoices carry the increment note.",
    "bun test passes."
  ],
  "open_questions": [],
  "implementation_contract": {
    "directives": [
      {
        "id": "d1",
        "text": "billedTenths is the one rounding rule, and every invoice line uses it for hours and amount.",
        "completion_check": "tests/time.test.ts covers the increment boundaries and tests/invoice.test.ts covers a rounded line."
      },
      {
        "id": "d2",
        "text": "Invoices carry the increment note.",
        "completion_check": "tests/invoice.test.ts asserts the note."
      }
    ]
  }
}
