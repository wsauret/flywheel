# elegance-shipping-quotes: seeded defect rationale

## to-dollars-duplicates-format-cents (shipping-options.ts, money.ts)

money.ts already owns display formatting of money as `formatCents`, and receipt.ts uses it. The change adds a private `toDollars(cents)` in shipping-options.ts that does the same job a second way (`(cents / 100).toFixed(2)`). Two formatters for one concept will drift; they already differ: `toDollars(-5)` gives `"$-0.05"` where `formatCents(-5)` gives `"-$0.05"`, and one uses floating point where the other uses integer arithmetic. Shipping prices are never negative, so the difference does not show today, which is why the duplicate is an elegance defect rather than a visible bug. The fix is to import `formatCents`. The helper looks deliberate because it is tiny, private, and well named.

## unread-last-quotes (quotes.ts)

`QuoteService.lastQuotes` is assigned at the end of every `quoteAll` call. No module reads it: `shippingStep` uses the returned set, and `renderShippingOptions` takes the set as a parameter. The field and the assignment can be deleted with no change in behavior. It is public, so the compiler does not warn, and "remember the last result" reads like a feature on a skim.

## What is intended

- Quoting carriers with `Promise.all` over per-carrier outcomes is the feature: a failed carrier becomes "unavailable" and does not hide the others. Carriers apply their own timeouts (carriers.ts), so `quoteAll` always settles.
- The sort tie-breaks on carrier name so equal prices list in a stable order.
- `shippingStep` is the checkout entry point that joins quoting and rendering; it is the consumer of both modules, not a forwarding layer.
