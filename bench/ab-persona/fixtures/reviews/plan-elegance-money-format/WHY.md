# plan-elegance-money-format: control

This fixture seeds no defect. It is a clean plan that contains choices a reflexive structural reviewer tends to flag. Each is correct here.

## Tempting findings that are wrong

- "The currencySymbol conversion is a compatibility shim." It has a real producer: settings.json files that earlier releases wrote with `submitSettings`, which README.md says every release must read. Without it every shop would silently fall back to USD on upgrade. The branch is dated for removal and its test feeds the old shape; that is the standard handling of durable user state.
- "The symbol-to-code map in the loader duplicates the maps being deleted." The plan deletes the two existing maps (in render.ts and receipt.ts) and keeps one, inside the conversion branch, where it describes the old file format only. The map count goes from two to one.
- "formatMoney is a one-line wrapper over Intl.NumberFormat." It replaces three formatting styles that have already drifted apart, has three callers, and fixes the options (`style: "currency"`, cents to units) that each caller would otherwise repeat. The extraction is the feature.
- "Storing the code is churn; keep the symbol." The constraint shows why it is required: "$" cannot name CAD or AUD, and Intl needs the code.
- "Pick<ShopSettings, ...> is over-typed." It lets the formatter take the settings object the callers already hold while stating the two fields it reads.
