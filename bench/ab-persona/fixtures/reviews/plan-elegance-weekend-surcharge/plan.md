{
  "schema_version": 1,
  "summary": "Add a weekend surcharge to delivery quotes: a pickup on a Saturday or Sunday adds 15% of the subtotal as its own quote line, as operations asked.",
  "context": {
    "key_files": [
      "src/pricing/quote.ts - DeliveryRequest, QuoteLine, Quote, and quoteDelivery(request, now), which builds the lines and the total. `now` is the pickup time and is not yet read.",
      "src/pricing/rates.ts - The fee constants.",
      "src/http/quote-route.ts - handleQuote parses the request body and returns the quote.",
      "tests/quote.test.ts - Existing coverage."
    ],
    "patterns": [
      "Every charge is a QuoteLine with a label; totalCents is the sum of the lines.",
      "Fee constants live in src/pricing/rates.ts."
    ],
    "constraints": [
      "Weekday quotes are unchanged.",
      "The surcharge is 15% of the sum of the other lines, rounded to the cent."
    ],
    "project_docs": []
  },
  "phases": [
    {
      "id": "phase-1",
      "goal": "Add the weekend surcharge to quoteDelivery.",
      "files": [
        "src/pricing/rates.ts",
        "src/pricing/rules.ts",
        "src/pricing/quote.ts",
        "tests/quote.test.ts",
        "tests/rules.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Add `WEEKEND_SURCHARGE_RATE = 0.15` to src/pricing/rates.ts.",
          "files": [
            "src/pricing/rates.ts"
          ],
          "test_scenarios": []
        },
        {
          "id": "t2",
          "description": "Add src/pricing/rules.ts with a `PricingRule` interface (`name: string; applies(request: DeliveryRequest, now: Date): boolean; line(subtotalCents: number): QuoteLine`), a `PricingRuleRegistry` class with `register(rule)` and `apply(request, now, lines): QuoteLine[]` that appends the line of every rule that applies, in registration order, and `WeekendSurchargeRule`, whose applies checks `now.getDay()` for 0 or 6 and whose line is `{ label: \"Weekend surcharge\", cents: Math.round(subtotalCents * WEEKEND_SURCHARGE_RATE) }`. New rules such as holiday or peak-hour pricing can then register without touching quoteDelivery.",
          "files": [
            "src/pricing/rules.ts",
            "tests/rules.test.ts"
          ],
          "test_scenarios": [
            "WeekendSurchargeRule applies on Saturday and Sunday and not on Friday.",
            "The registry applies registered rules in registration order.",
            "A registry with no rules returns the lines unchanged."
          ]
        },
        {
          "id": "t3",
          "description": "In src/pricing/quote.ts, create one module-level `PricingRuleRegistry`, register `new WeekendSurchargeRule()`, and pass the base lines through `registry.apply(request, now, lines)` before totalling. Remove the `void now;` line.",
          "files": [
            "src/pricing/quote.ts",
            "tests/quote.test.ts"
          ],
          "test_scenarios": [
            "A Saturday quote for 10 km, not bulky, has a Weekend surcharge line of 255 cents and a total of 1955.",
            "A Wednesday quote has no surcharge line."
          ]
        }
      ],
      "verification": "bun test",
      "qualitative_verification": null
    }
  ],
  "success_criteria": [
    "Weekend pickups show a Weekend surcharge line of 15% of the other lines.",
    "Weekday quotes are unchanged.",
    "bun test passes."
  ],
  "open_questions": [],
  "implementation_contract": {
    "directives": [
      {
        "id": "d1",
        "text": "A Saturday or Sunday pickup adds a Weekend surcharge line of 15% of the other lines.",
        "completion_check": "tests/quote.test.ts asserts the Saturday and Wednesday cases."
      }
    ]
  }
}
