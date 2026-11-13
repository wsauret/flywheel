{
  "schema_version": 1,
  "summary": "Show each customer's loyalty tier as a badge on the receipt, and gather the loyalty rules under src/loyalty/ as the loyalty team asked. The tier becomes a field of the customer record so checkout and the receipt read one value, and the tier rules move to src/loyalty/tiers.ts.",
  "context": {
    "key_files": [
      "src/tiers.ts - TIERS, the Tier type, tierFor(points), and discountFor(tier). Moves to src/loyalty/tiers.ts in phase 1.",
      "src/customers.ts - Customer record mapping plus awardPoints and redeemPoints, the only two writers of a points balance.",
      "src/db.ts - CustomerRow and the Database storage port.",
      "src/checkout.ts - priceOrder applies the tier discount.",
      "src/receipt.ts - renderReceipt, the plain-text receipt that gets the badge.",
      "migrations/001_customers.sql - The customers table.",
      "tests/tiers.test.ts, tests/receipt.test.ts - Existing coverage of the tier rules and the receipt."
    ],
    "patterns": [
      "Customer fields map one to one onto customers columns through fromRow and toRow.",
      "Schema changes ship as a numbered SQL migration that the deploy pipeline applies in file-name order.",
      "Tests import modules by relative path from tests/."
    ],
    "constraints": [
      "Tier thresholds and discounts do not change in this plan.",
      "The receipt keeps every existing line; the badge is one new line under the customer name.",
      "README.md: the service is deployed alone and nothing outside this repository imports its modules."
    ],
    "project_docs": [
      "README.md"
    ]
  },
  "phases": [
    {
      "id": "phase-1",
      "goal": "Move the tier rules into src/loyalty/.",
      "files": [
        "src/loyalty/tiers.ts",
        "src/tiers.ts",
        "src/checkout.ts",
        "tests/tiers.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Move the contents of src/tiers.ts unchanged to src/loyalty/tiers.ts. Update the imports in src/checkout.ts and tests/tiers.test.ts to the new path.",
          "files": [
            "src/loyalty/tiers.ts",
            "src/checkout.ts",
            "tests/tiers.test.ts"
          ],
          "test_scenarios": [
            "tests/tiers.test.ts passes unchanged apart from its import path."
          ]
        },
        {
          "id": "t2",
          "description": "Replace the body of src/tiers.ts with `export * from \"./loyalty/tiers\";` and a deprecation comment, so that existing imports of ./tiers keep working while callers move to the new path. Remove the file in a later cleanup once no import of it remains.",
          "files": [
            "src/tiers.ts"
          ],
          "test_scenarios": [
            "An import of tierFor from src/tiers.ts still resolves and returns the same tier as src/loyalty/tiers.ts."
          ]
        }
      ],
      "verification": "bun test tests/tiers.test.ts",
      "qualitative_verification": null
    },
    {
      "id": "phase-2",
      "goal": "Make the tier a field of the customer record.",
      "files": [
        "migrations/002_customer_tier.sql",
        "src/db.ts",
        "src/customers.ts",
        "src/checkout.ts",
        "tests/customers.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Add migrations/002_customer_tier.sql: `ALTER TABLE customers ADD COLUMN tier TEXT NOT NULL DEFAULT 'bronze'`, then backfill existing rows with `UPDATE customers SET tier = CASE WHEN points_balance >= 5000 THEN 'gold' WHEN points_balance >= 1000 THEN 'silver' ELSE 'bronze' END`.",
          "files": [
            "migrations/002_customer_tier.sql"
          ],
          "test_scenarios": [
            "After the migration a row with 1200 points has tier silver and a row with 0 points has tier bronze."
          ]
        },
        {
          "id": "t2",
          "description": "Add `tier: Tier` to CustomerRow and Customer and map it in fromRow and toRow. In awardPoints and redeemPoints, set `tier: tierFor(nextBalance)` on the record they write, so the stored tier follows every balance change.",
          "files": [
            "src/db.ts",
            "src/customers.ts",
            "tests/customers.test.ts"
          ],
          "test_scenarios": [
            "Awarding points that cross 1000 stores tier silver.",
            "Redeeming points that drop the balance below 5000 stores tier silver.",
            "getCustomer returns the stored tier."
          ]
        },
        {
          "id": "t3",
          "description": "In priceOrder, read the discount from the stored tier: `discountFor(customer.tier)`.",
          "files": [
            "src/checkout.ts"
          ],
          "test_scenarios": [
            "A gold customer gets a 10% discount."
          ]
        }
      ],
      "verification": "bun test tests/customers.test.ts tests/tiers.test.ts",
      "qualitative_verification": null
    },
    {
      "id": "phase-3",
      "goal": "Show the tier badge on the receipt.",
      "files": [
        "src/loyalty/tiers.ts",
        "src/receipt.ts",
        "tests/receipt.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Add `tierLabel(tier: Tier): string` to src/loyalty/tiers.ts, which returns \"Gold member\", \"Silver member\", or \"Bronze member\". In renderReceipt, add the line `Tier: ${tierLabel(customer.tier)}` directly under the customer name.",
          "files": [
            "src/loyalty/tiers.ts",
            "src/receipt.ts",
            "tests/receipt.test.ts"
          ],
          "test_scenarios": [
            "A silver customer's receipt shows \"Tier: Silver member\" under the customer line.",
            "The other receipt lines are unchanged."
          ]
        }
      ],
      "verification": "bun test",
      "qualitative_verification": null
    }
  ],
  "success_criteria": [
    "Every receipt shows the customer's tier as a badge line.",
    "The tier rules live in src/loyalty/tiers.ts.",
    "Checkout discounts are unchanged for every balance.",
    "bun test passes."
  ],
  "open_questions": [],
  "implementation_contract": {
    "directives": [
      {
        "id": "d1",
        "text": "The receipt shows the tier badge under the customer name.",
        "completion_check": "tests/receipt.test.ts asserts the badge line for a silver customer."
      },
      {
        "id": "d2",
        "text": "The tier rules live in src/loyalty/tiers.ts.",
        "completion_check": "src/checkout.ts and the tests import from src/loyalty/tiers.ts."
      }
    ]
  }
}
