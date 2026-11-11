# elegance-clearing-export: seeded defect rationale

## hand-rolled-pad-start (export.ts)

`padLeft(value, width, fill)` loops, prepending `fill` until the string reaches `width`. That is exactly `String.prototype.padStart(width, fill)`, and the same project already uses `padStart` two lines into `formatDate`. The helper adds code to read and test and no behavior: for every input the change passes (a formatted amount and a single space) the result is identical. The elegant shape is `formatAmount(tx.amountCents).padStart(AMOUNT_WIDTH)`. The helper looks deliberate on a skim because it is small, private, and well named.

## format-date-reexport-shim (export.ts, summary.ts)

The change moves `formatDate` from export.ts to the new format.ts and updates every importer: summary.ts now imports from format.ts, and export.ts imports it from format.ts for its own use. It still keeps `export { formatDate } from "./format.ts";`. No module in the project imports `formatDate` from export.ts any more, and the project is an application module set, not a published package with outside importers. The line is a compatibility re-export with no consumer: it leaves two import paths for one function and invites new code to use the old one. Deleting it changes nothing. It looks deliberate because a re-export after a move is a common habit in libraries.

## What is intended

The fixed-width record layout (10 + 12 + 14 characters) is the clearing-house format; account numbers are always twelve digits (types.ts), so only the amount needs padding. `formatAmount` has two real callers (CSV and fixed width), so extracting it is right.
