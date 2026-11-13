{
  "schema_version": 1,
  "summary": "Tell the buyers what to reorder: GET /stock/:sku gains a needsReorder flag, and a new nightly job writes the list of SKUs whose available units are at or below their reorder point.",
  "context": {
    "key_files": [
      "ARCHITECTURE.md - The four layers and their allowed imports.",
      "src/domain/stock.ts - StockItem (with reorderPoint) and availableUnits.",
      "src/db/products.ts - ProductRow, ProductTable, listStockItems, getStockItem.",
      "src/http/stock-routes.ts - handleStock, GET /stock/:sku.",
      "src/http/admin-routes.ts - handleSetReorderPoint, PUT /admin/products/:sku/reorder-point.",
      "src/jobs/valuation.ts - The existing nightly job, for the job pattern.",
      "src/server.ts - startServer routes the HTTP requests.",
      "tests/stock.test.ts - Existing coverage."
    ],
    "patterns": [
      "A job is an exported async function over ProductTable that the scheduler process calls.",
      "Routes return JSON with Response.json."
    ],
    "constraints": [
      "A product needs reorder when its available units (onHand minus reserved, never below 0) are at or below its reorder point.",
      "The reorder report is a sorted list of SKUs."
    ],
    "project_docs": [
      "ARCHITECTURE.md"
    ]
  },
  "phases": [
    {
      "id": "phase-1",
      "goal": "Show the needsReorder flag on the stock route.",
      "files": [
        "src/config/reorder-thresholds.ts",
        "src/http/stock-routes.ts",
        "src/server.ts",
        "tests/reorder-thresholds.test.ts",
        "tests/stock-routes.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Add src/config/reorder-thresholds.ts with `loadReorderThresholds(table: ProductTable): Promise<Map<string, number>>`, which reads listStockItems once and maps each SKU to its reorderPoint. startServer calls it once at startup and passes the map to handleStock, so the route looks up one table instead of carrying thresholds through every item.",
          "files": [
            "src/config/reorder-thresholds.ts",
            "src/server.ts",
            "tests/reorder-thresholds.test.ts"
          ],
          "test_scenarios": [
            "The map holds the reorder point of every product in the table."
          ]
        },
        {
          "id": "t2",
          "description": "In src/http/stock-routes.ts, add and export `needsReorder(item: StockItem, thresholds: Map<string, number>): boolean`, which returns `availableUnits(item) <= (thresholds.get(item.sku) ?? 0)`. handleStock takes the thresholds map and adds `needsReorder` to its JSON.",
          "files": [
            "src/http/stock-routes.ts",
            "tests/stock-routes.test.ts"
          ],
          "test_scenarios": [
            "An item with 6 available and reorder point 6 needs reorder.",
            "An item with 7 available and reorder point 6 does not.",
            "The stock route JSON includes needsReorder."
          ]
        }
      ],
      "verification": "bun test tests/stock-routes.test.ts tests/reorder-thresholds.test.ts",
      "qualitative_verification": null
    },
    {
      "id": "phase-2",
      "goal": "Write the nightly reorder report.",
      "files": [
        "src/jobs/reorder-report.ts",
        "tests/reorder-report.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Add src/jobs/reorder-report.ts with `reorderReport(table: ProductTable): Promise<string[]>`. It loads the thresholds with loadReorderThresholds(table), lists the items with listStockItems, keeps the items for which needsReorder (imported from ../http/stock-routes, so that the route and the job apply one rule) returns true, and returns their SKUs sorted.",
          "files": [
            "src/jobs/reorder-report.ts",
            "tests/reorder-report.test.ts"
          ],
          "test_scenarios": [
            "Of three products, the two at or below their reorder point are listed, sorted by SKU.",
            "An empty table gives an empty list."
          ]
        }
      ],
      "verification": "bun test",
      "qualitative_verification": null
    }
  ],
  "success_criteria": [
    "GET /stock/:sku returns needsReorder.",
    "The nightly job returns the sorted SKUs that need reorder.",
    "The route and the job agree for every product.",
    "bun test passes."
  ],
  "open_questions": [],
  "implementation_contract": {
    "directives": [
      {
        "id": "d1",
        "text": "The route and the job apply the same reorder rule.",
        "completion_check": "Both call one needsReorder function."
      }
    ]
  }
}
