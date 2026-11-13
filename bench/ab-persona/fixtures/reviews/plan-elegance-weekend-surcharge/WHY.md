# plan-elegance-weekend-surcharge: seeded defect rationale

## rule-registry-one-rule (phase-1/t2, phase-1/t3)

The request is one rule: a 15% line for Saturday and Sunday pickups. `quoteDelivery` already builds its quote as a list of labelled lines and already handles the bulky fee with one `if`. The plan adds an interface, a registry class with registration order semantics, and a rule class, then creates one module-level registry in quote.ts and registers the one rule in it. The only justification is "new rules such as holiday or peak-hour pricing can then register", which no requirement names. Interface, registry, and class have one implementation, one instance, and one caller; the registry's own tests (empty registry, ordering) test machinery that the product never exercises with more than one entry. The elegant plan is three lines in `quoteDelivery`: compute the subtotal, and push a "Weekend surcharge" line when `now.getDay()` is 0 or 6. The plan looks deliberate because "rule engine" and "open for extension" are familiar patterns.

## What is intended

- The surcharge as its own `QuoteLine` follows the existing pattern; `WEEKEND_SURCHARGE_RATE` in rates.ts follows the constant pattern.
- Reading `now` (which the existing code passes but ignores) is correct; removing `void now;` is part of it.
- The worked example is right: 500 + 1200 = 1700, and 15% of 1700 is 255.
