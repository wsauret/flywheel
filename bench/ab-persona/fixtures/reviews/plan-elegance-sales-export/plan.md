{
  "schema_version": 1,
  "summary": "Add a CSV download of the daily sales report at /reports/sales.csv, beside the existing HTML report, so the bookkeeper can open it in a spreadsheet. Each row is one day with its order count, units, and revenue in dollars.",
  "context": {
    "key_files": [
      "src/reports/sales.ts - Sale, SalesDay, salesByDay (one row per store-local day), and renderSalesHtml.",
      "src/reports/stock.ts - stockCsv, the existing CSV report, built with toCsv.",
      "src/format/csv.ts - toCsv(headers, rows): RFC 4180 output.",
      "src/format/dates.ts - formatDate(date, timeZone).",
      "src/settings.ts - storeTimeZone.",
      "src/http/report-routes.ts - handleReport routes /reports/sales and /reports/stock.csv and parses the from and to query range.",
      "tests/sales.test.ts, tests/csv.test.ts - Existing coverage."
    ],
    "patterns": [
      "A report module builds its rows; src/format/ owns output encodings; report-routes.ts maps a path to a report.",
      "Money in rows is cents until the encoding step."
    ],
    "constraints": [
      "The HTML report is unchanged.",
      "The CSV uses the same from and to range parameters as the HTML report."
    ],
    "project_docs": []
  },
  "phases": [
    {
      "id": "phase-1",
      "goal": "Build the sales CSV.",
      "files": [
        "src/format/csv-exporter.ts",
        "src/reports/sales-csv.ts",
        "tests/sales-csv.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Add src/format/csv-exporter.ts with `class CsvExporter { export(headers: readonly string[], rows: readonly (readonly string[])[]): string { return toCsv(headers, rows); } }`. Report modules depend on an exporter object instead of importing the formatting function, which keeps the CSV encoding behind one class.",
          "files": [
            "src/format/csv-exporter.ts"
          ],
          "test_scenarios": [
            "CsvExporter.export returns the same text as toCsv for the same input."
          ]
        },
        {
          "id": "t2",
          "description": "Add src/reports/sales-csv.ts with `salesCsv(exporter: CsvExporter, sales: readonly Sale[]): string`. A local `groupByDay(sales)` builds a Map keyed by `formatDate(sale.soldAt, settings.storeTimeZone)` that sums the order count, units, and revenue cents of each day, and returns the entries sorted by day. salesCsv passes the header `Day,Orders,Units,Revenue` and one row per grouped day, with revenue as dollars to two decimals, to exporter.export.",
          "files": [
            "src/reports/sales-csv.ts",
            "tests/sales-csv.test.ts"
          ],
          "test_scenarios": [
            "Two sales on one store day give one row with orders 2 and the summed units and revenue.",
            "A sale at 04:30 UTC counts toward the previous Chicago day.",
            "Revenue 1234 cents renders as 12.34."
          ]
        }
      ],
      "verification": "bun test tests/sales-csv.test.ts tests/csv.test.ts",
      "qualitative_verification": null
    },
    {
      "id": "phase-2",
      "goal": "Serve the CSV.",
      "files": [
        "src/http/report-routes.ts",
        "tests/report-routes.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "In handleReport, route /reports/sales.csv: parse the range with range(url), load the sales with sources.salesBetween(from, to), construct a CsvExporter, and return salesCsv(exporter, sales) with content-type text/csv and `Content-Disposition: attachment; filename=\"sales.csv\"`.",
          "files": [
            "src/http/report-routes.ts",
            "tests/report-routes.test.ts"
          ],
          "test_scenarios": [
            "GET /reports/sales.csv?from=...&to=... returns 200, text/csv, and the attachment header.",
            "A missing range returns 400, as for the HTML report."
          ]
        }
      ],
      "verification": "bun test",
      "qualitative_verification": "Open the downloaded file in a spreadsheet and confirm one row per day."
    }
  ],
  "success_criteria": [
    "/reports/sales.csv returns the daily sales rows as a CSV download.",
    "The HTML report is unchanged.",
    "bun test passes."
  ],
  "open_questions": [],
  "implementation_contract": {
    "directives": [
      {
        "id": "d1",
        "text": "The sales CSV has one row per store day with orders, units, and revenue.",
        "completion_check": "tests/sales-csv.test.ts asserts the rows."
      }
    ]
  }
}
