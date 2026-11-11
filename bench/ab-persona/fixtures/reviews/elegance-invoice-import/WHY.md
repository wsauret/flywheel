# elegance-invoice-import: seeded defect rationale

## single-use-pipeline (src/import/pipeline.ts, src/import/importer.ts)

`Pipeline<TIn, TOut>` is a generic, well-typed composition helper with `from`, `then`, and `run`. It has one use in the whole project: `readInvoices` in importer.ts chains `parseCsv`, `dataRows`, `parseInvoiceRows`, and `groupIntoInvoices`. Function composition already does this with no new type: `groupIntoInvoices(parseInvoiceRows(dataRows(parseCsv(csvText))))`, or four `const` lines. The class adds no capability (no stage names, error context, timing, or async), so it is a premature abstraction that a reader must learn for one call site. It looks deliberate because it is clean, type-safe, and has a good doc comment.

## unreachable-line-guard (src/totals.ts, src/invoice.ts)

`createInvoice` is documented as the one way an invoice enters the system, and it throws for any line whose quantity is not a whole number of at least 1 or whose price is negative. The manual form uses it, and the change routes the import through it too (`groupIntoInvoices`). The change then rewrites `invoiceTotalCents` to skip lines with `quantity <= 0 || unitCents < 0`. No producer can create such a line, so the branch is dead defensive code; worse, if the invariant ever broke, it would quietly drop money from totals instead of failing. The total should stay the plain sum it was before the change. It looks deliberate because "ignore bad lines" reads like caution.

## What is intended

- The row parser checks only the form of each field (a whole number, a price like 12.50, a real calendar date, a known currency) and leaves the payable rules to `createInvoice`; its comment says so, so the import does not repeat the domain rules.
- The header check, field count check, and date/currency agreement across rows of one invoice are validation of a supplier file, an external boundary.
- Checking the whole file before posting is the stated atomicity contract, and skipping already posted invoices supports resent files.
- `parsePriceCents` uses integer arithmetic on purpose.
- Errors name the CSV row (`Row N`, the header is row 1), not the text line: `parseCsv` drops blank lines and keeps a quoted field that spans lines in one row, and the `rowNumber` doc comment states this.
- `csv.ts` and `ledger.ts` are unchanged.
