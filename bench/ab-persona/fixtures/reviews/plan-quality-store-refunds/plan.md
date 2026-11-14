{
  "schema_version": 1,
  "summary": "Let the cashier choose where a refund goes, as REQUEST.md asks: back to the original payment method, which stays the default, or onto a gift card, new or existing. refundSale takes the destination, the refund record keeps it, and the till route reads the cashier's choice.",
  "context": {
    "key_files": [
      "REQUEST.md - The shop managers' request.",
      "src/sales.ts - Sale, Refund, the RefundDestination union (today only { kind: \"original\" }), and the SaleStore port.",
      "src/payments/refunds.ts - refundableCents and refundSale(deps, saleId, amountCents), which checks the amount, refunds the card through the gateway, and records the refund.",
      "src/giftcards/giftcards.ts - issueGiftCard and loadGiftCard; loadGiftCard throws GiftCardError for an unknown card number.",
      "src/till/routes.ts - postRefund, the till app's POST /sales/:saleId/refunds route and the caller of refundSale.",
      "tests/refunds.test.ts, tests/fakes.ts - Existing refund coverage and the in-memory dependencies it uses."
    ],
    "patterns": [
      "Domain functions take a deps object; tests build it with fakeDeps in tests/fakes.ts.",
      "Domain errors are typed classes; routes map them to 422 and rethrow anything else.",
      "Money is integer cents."
    ],
    "constraints": [
      "The refundable-amount rules in refundableCents and refundSale do not change.",
      "A till request with no destination keeps today's card refund.",
      "Refund records already carry a destination field, so the end-of-day report needs no schema change."
    ],
    "project_docs": [
      "README.md",
      "REQUEST.md"
    ]
  },
  "phases": [
    {
      "id": "phase-1",
      "goal": "refundSale refunds to the chosen destination and records it.",
      "files": [
        "src/sales.ts",
        "src/payments/refunds.ts",
        "tests/fakes.ts",
        "tests/refunds.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Extend RefundDestination in src/sales.ts with `{ kind: \"gift-card\"; cardNumber: string }`. The card number is the card the money went to, also when refundSale issued it.",
          "files": [
            "src/sales.ts"
          ],
          "test_scenarios": [
            "The type change compiles with the existing tests unchanged."
          ]
        },
        {
          "id": "t2",
          "description": "Change the signature to `refundSale(deps, saleId, amountCents, destination: RefundRequestDestination)`, where `RefundRequestDestination = { kind: \"original\" } | { kind: \"gift-card\"; cardNumber?: string }` is exported from src/payments/refunds.ts. The parameter is required so that every caller states where the money goes. Keep the amount checks first and unchanged. For `original`, keep today's path: refuse a cash sale, then call deps.gateway.refund. For `gift-card`, call loadGiftCard when cardNumber is given and issueGiftCard otherwise, and record `{ kind: \"gift-card\", cardNumber: card.number }`. A gift-card refund is allowed for a cash sale, because no card refund takes place. Add `giftCards: GiftCardStore` and `newGiftCardNumber: () => string` to RefundDeps, and add both to fakeDeps.",
          "files": [
            "src/payments/refunds.ts",
            "tests/fakes.ts",
            "tests/refunds.test.ts"
          ],
          "test_scenarios": [
            "An original refund of a card sale calls the gateway and records { kind: \"original\" } (the existing test, with the destination argument added).",
            "A gift-card refund with no card number issues a new card holding the amount, makes no gateway call, and records its number.",
            "A gift-card refund with an existing card number adds the amount to that card's balance.",
            "A gift-card refund to an unknown card number throws GiftCardError and records no refund.",
            "A gift-card refund of a cash sale succeeds.",
            "A gift-card refund above the refundable remainder throws RefundError and loads no card."
          ]
        }
      ],
      "verification": "bun test tests/refunds.test.ts",
      "qualitative_verification": null
    },
    {
      "id": "phase-2",
      "goal": "The till route passes the cashier's choice.",
      "files": [
        "src/till/routes.ts",
        "tests/routes.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "In postRefund, read an optional `destination` from the body: absent means `{ kind: \"original\" }`; `{ kind: \"gift-card\" }` with an optional string `cardNumber` is passed through; any other value is a 400 that names the field. Pass the destination to refundSale. Map GiftCardError to 422 next to RefundError.",
          "files": [
            "src/till/routes.ts",
            "tests/routes.test.ts"
          ],
          "test_scenarios": [
            "A body with only amountCents refunds the card and returns 201.",
            "A body with destination { kind: \"gift-card\" } returns 201 with the new card number in the refund.",
            "A body with destination { kind: \"cheque\" } returns 400.",
            "An unknown gift card number returns 422."
          ]
        }
      ],
      "verification": "bun test",
      "qualitative_verification": null
    }
  ],
  "success_criteria": [
    "A cashier can refund to the original payment method or to a new or existing gift card.",
    "A till request without a destination behaves as today.",
    "Every refund record names its destination.",
    "bun test passes."
  ],
  "open_questions": [],
  "implementation_contract": {
    "directives": [
      {
        "id": "d1",
        "text": "refundSale takes a required destination and records where the money went.",
        "completion_check": "tests/refunds.test.ts covers the original and both gift-card paths."
      },
      {
        "id": "d2",
        "text": "postRefund defaults to the original payment method.",
        "completion_check": "tests/routes.test.ts asserts a body without destination refunds the card."
      }
    ]
  }
}
