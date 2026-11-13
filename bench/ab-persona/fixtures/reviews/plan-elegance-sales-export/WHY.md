# plan-elegance-sales-export: seeded defect rationale

## csv-exporter-shallow-wrapper (phase-1/t1, phase-2/t1)

`CsvExporter.export(headers, rows)` returns `toCsv(headers, rows)` and nothing else. It holds no state, adds no option, and replaces no implementation, yet the plan threads it through `salesCsv` as a parameter and constructs it in the route. The stated reason, "keeps the CSV encoding behind one class", is already true of the function: `toCsv` in src/format/csv.ts is the one owner of the encoding, and the existing `stockCsv` calls it directly. The class looks like dependency inversion, but nothing injects a second exporter and the tests compare it with `toCsv`, which shows it is the same thing under a new name.

## regroup-sales-by-day (phase-1/t2)

`salesByDay` in src/reports/sales.ts groups sales by store-local day with `formatDate(sale.soldAt, settings.storeTimeZone)`, sums orders, units, and revenue cents, and sorts by day. Its `SalesDay` rows are exactly the CSV's rows. The plan writes a local `groupByDay` with the same key, the same sums, and the same sort, so the HTML and CSV reports would each own the grouping rule. A later change to one (for example, excluding refunded sales) would make the two reports disagree. The plan reads as careful because it uses the right time-zone helper and even tests the evening edge case, which hides that the whole function already exists. `salesCsv` should map `salesByDay(sales)` to rows.

## What is intended

- A separate src/reports/sales-csv.ts module follows the existing report pattern (src/reports/stock.ts).
- Converting cents to dollars at the encoding step follows the project pattern.
- The route reuses `range(url)` and returns 400 for a missing range, the same as the HTML report.
