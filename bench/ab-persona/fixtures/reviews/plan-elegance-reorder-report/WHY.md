# plan-elegance-reorder-report: seeded defect rationale

## reorder-rule-in-http-layer (phase-1/t2, phase-2/t1)

ARCHITECTURE.md is explicit: every stock rule lives in src/domain/ so that routes and jobs apply the same rule, and a job never imports src/http/. The plan puts `needsReorder` in src/http/stock-routes.ts, next to the first place it is shown, and then has the nightly job import it from the route module. The plan even names the right goal ("so that the route and the job apply one rule") and reaches it through the wrong home. The rule is a pure function of a `StockItem`, exactly like `availableUnits`, and belongs beside it in src/domain/stock.ts.

## reorder-threshold-copy (phase-1/t1, phase-1/t2, phase-2/t1)

`StockItem.reorderPoint` is the one home of a product's threshold: `toItem` maps it from the `reorder_point` column, and `handleSetReorderPoint` lets the buyers change it during the day. The plan copies every threshold into a `Map` once at server startup and makes `needsReorder` read the map instead of the item it already holds. After the first admin edit the route reports against the old value until the server restarts. The job builds its own copy each night, so the route and the job can disagree, which is the opposite of the plan's success criterion. The `?? 0` default then covers a SKU missing from the map, a state the copy itself creates. The plan's reason, "instead of carrying thresholds through every item", is backwards: the items already carry them.

## What is intended

- A `needsReorder` boolean on the stock route and a sorted SKU list from the job are the feature.
- The job follows the existing pattern of src/jobs/valuation.ts.
- The boundary rule "at or below" is the stated constraint, and the test cases at 6 and 7 cover it.
