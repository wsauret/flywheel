{
  "schema_version": 1,
  "summary": "Shops in Canada and Australia asked for their currencies, and amounts look different on every screen today (\"$12.50\" in the cart, \"12.50 USD\" on invoices, a locale format in emails). Add CAD and AUD, store the shop's currency as an ISO 4217 code, and show every amount in one locale-aware format.",
  "context": {
    "key_files": [
      "README.md - settings.json lives in the app data folder; every release reads the file that earlier releases wrote.",
      "src/settings/choices.ts - SYMBOL_CHOICES ($, €, £), the options the settings page offers today.",
      "src/settings/load.ts - ShopSettings, DEFAULT_SETTINGS, loadSettings (a missing or invalid field, including an unsupported locale, takes its default with a warning), saveSettings.",
      "src/settings/page.ts - currencyOptions and submitSettings, the only writer of settings.json.",
      "src/cart/summary.ts - cartSummary: symbol plus toFixed(2).",
      "src/invoices/render.ts - renderInvoice: toFixed(2) plus a code from its own CODE_FOR_SYMBOL map.",
      "src/emails/receipt.ts - receiptEmail: Intl.NumberFormat with a code from its own CURRENCY map.",
      "tests/settings.test.ts, tests/receipt.test.ts - Existing coverage."
    ],
    "patterns": [
      "loadSettings never fails on a bad file: a missing or invalid field takes its default with a warning.",
      "Amounts are integer cents until they are shown."
    ],
    "constraints": [
      "\"$\" can no longer name the currency once CAD and AUD exist, so the stored value must be the code.",
      "Releases up to now offered only $, €, and £, so a stored symbol maps to exactly one code: $ to USD, € to EUR, £ to GBP.",
      "Installing the new release must keep each shop's currency without a visit to the settings page."
    ],
    "project_docs": [
      "README.md"
    ]
  },
  "phases": [
    {
      "id": "phase-1",
      "goal": "Store the currency as a code and read the files that earlier releases wrote.",
      "files": [
        "src/settings/choices.ts",
        "src/settings/load.ts",
        "src/settings/page.ts",
        "tests/settings.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Replace SYMBOL_CHOICES with `CURRENCY_CHOICES = [\"USD\", \"EUR\", \"GBP\", \"CAD\", \"AUD\"] as const` and its `Currency` type. ShopSettings gets `currency: Currency` in place of currencySymbol, and DEFAULT_SETTINGS uses USD. currencyOptions returns CURRENCY_CHOICES and submitSettings writes `currency`.",
          "files": [
            "src/settings/choices.ts",
            "src/settings/load.ts",
            "src/settings/page.ts"
          ],
          "test_scenarios": [
            "Submitting the form with CAD writes `\"currency\": \"CAD\"` and no currencySymbol."
          ]
        },
        {
          "id": "t2",
          "description": "In loadSettings, read `currency` when it is one of CURRENCY_CHOICES. Otherwise, when the file holds a `currencySymbol` written by an earlier release, map it with `{ \"$\": \"USD\", \"€\": \"EUR\", \"£\": \"GBP\" }`; mark the branch with the comment `Reads settings.json written before 3.0 (currencySymbol). Remove after 2027-06-30.` Any other value takes USD with a warning, as an invalid field does today. The next save from the settings page writes the new shape.",
          "files": [
            "src/settings/load.ts",
            "tests/settings.test.ts"
          ],
          "test_scenarios": [
            "A file with currencySymbol \"£\" and no currency loads as GBP with no warning.",
            "A file with currency \"AUD\" loads as AUD.",
            "A file with currencySymbol \"¥\" loads as USD with one warning.",
            "A missing file gives the defaults."
          ]
        }
      ],
      "verification": "bun test tests/settings.test.ts",
      "qualitative_verification": null
    },
    {
      "id": "phase-2",
      "goal": "Show every amount in one format.",
      "files": [
        "src/money/format.ts",
        "src/cart/summary.ts",
        "src/invoices/render.ts",
        "src/emails/receipt.ts",
        "tests/money.test.ts",
        "tests/cart.test.ts",
        "tests/invoice.test.ts",
        "tests/receipt.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Add src/money/format.ts with `formatMoney(cents: number, settings: Pick<ShopSettings, \"currency\" | \"locale\">): string`, which returns `new Intl.NumberFormat(settings.locale, { style: \"currency\", currency: settings.currency }).format(cents / 100)`.",
          "files": [
            "src/money/format.ts",
            "tests/money.test.ts"
          ],
          "test_scenarios": [
            "1250 cents in USD for en-US is \"$12.50\".",
            "1250 cents in CAD for en-CA is \"$12.50\" and for en-US is \"CA$12.50\".",
            "1250 cents in EUR for de-DE is \"12,50 €\" with a no-break space before the sign."
          ]
        },
        {
          "id": "t2",
          "description": "Use formatMoney in cartSummary, renderInvoice, and receiptEmail, and delete the CODE_FOR_SYMBOL map in src/invoices/render.ts and the CURRENCY map in src/emails/receipt.ts.",
          "files": [
            "src/cart/summary.ts",
            "src/invoices/render.ts",
            "src/emails/receipt.ts",
            "tests/cart.test.ts",
            "tests/invoice.test.ts",
            "tests/receipt.test.ts"
          ],
          "test_scenarios": [
            "The cart, the invoice, and the receipt email show the same text for the same amount and settings.",
            "An en-GB shop in GBP shows \"£12.50\" on all three."
          ]
        }
      ],
      "verification": "bun test",
      "qualitative_verification": "Start the app with a settings.json from the current release and confirm the cart shows the shop's currency without opening the settings page."
    }
  ],
  "success_criteria": [
    "Shops can choose CAD and AUD.",
    "Every screen shows an amount in the same locale-aware format.",
    "A settings.json from an earlier release keeps its currency.",
    "bun test passes."
  ],
  "open_questions": [],
  "implementation_contract": {
    "directives": [
      {
        "id": "d1",
        "text": "The stored currency is an ISO 4217 code, and settings.json files with currencySymbol still load with the same currency.",
        "completion_check": "tests/settings.test.ts feeds the old shape."
      },
      {
        "id": "d2",
        "text": "Cart, invoice, and receipt email format amounts through formatMoney.",
        "completion_check": "No toFixed(2) money formatting and no symbol-to-code map remains outside src/settings/load.ts."
      }
    ]
  }
}
