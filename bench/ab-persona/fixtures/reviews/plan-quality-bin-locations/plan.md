{
  "schema_version": 1,
  "summary": "Show each line's bin code on the pick list and let stock clerks set or clear an item's bin, as REQUEST.md asks. The pick list ships first, because pickers gain from it at once and items without a bin show \"-\"; the clerks' terminal route and the column follow in the second phase.",
  "context": {
    "key_files": [
      "REQUEST.md - The warehouse lead's request.",
      "src/items.ts - PickLine, the ItemRepo port, and SqlItemRepo.linesForOrder, which joins order_lines to items.",
      "src/picklist.ts - renderPickList, one text line per order line in line order.",
      "src/routes.ts - The terminal routes; getPickList serves the pick list.",
      "src/db.ts - migrate applies migrations/ in file-name order.",
      "migrations/001_items.sql, migrations/002_order_lines.sql - The current schema.",
      "tests/picklist.test.ts, tests/memory-item-repo.ts - Pick-list rendering over MemoryItemRepo.",
      "README.md - Deploys: each merge to main deploys at once, migrations first."
    ],
    "patterns": [
      "SQL lives only in SqlItemRepo; rendering and routes take the ItemRepo port.",
      "Schema changes are numbered SQL files in migrations/.",
      "Rendering tests build their data with MemoryItemRepo."
    ],
    "constraints": [
      "Each phase is one merge to main and deploys on its own.",
      "The order of the pick-list lines does not change.",
      "A bin code is one capital letter, a dash, two digits, a dash, and one digit."
    ],
    "project_docs": [
      "README.md",
      "REQUEST.md"
    ]
  },
  "phases": [
    {
      "id": "phase-1",
      "goal": "Pickers see the bin code of each line.",
      "files": [
        "src/items.ts",
        "src/picklist.ts",
        "tests/picklist.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Add `binCode: string | null` to PickLine. In SqlItemRepo.linesForOrder, select `i.bin_code` and map it to binCode. MemoryItemRepo stores whole PickLine values, so it needs no change.",
          "files": [
            "src/items.ts"
          ],
          "test_scenarios": [
            "The project type-checks with the new field."
          ]
        },
        {
          "id": "t2",
          "description": "In renderPickList, add the bin code after the line number: `${(line.binCode ?? \"-\").padEnd(6)}`. Keep the line order.",
          "files": [
            "src/picklist.ts",
            "tests/picklist.test.ts"
          ],
          "test_scenarios": [
            "A line whose item is in bin A-03-2 shows A-03-2.",
            "A line whose item has no bin shows -.",
            "The lines stay in line order."
          ]
        }
      ],
      "verification": "bun test tests/picklist.test.ts",
      "qualitative_verification": "Print the pick list of one order from the staging terminal and check the bin column lines up."
    },
    {
      "id": "phase-2",
      "goal": "Stock clerks set or clear the bin of an item.",
      "files": [
        "migrations/003_item_bin_code.sql",
        "src/bins.ts",
        "src/items.ts",
        "src/routes.ts",
        "tests/memory-item-repo.ts",
        "tests/bins.test.ts",
        "tests/routes.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Add migrations/003_item_bin_code.sql: `ALTER TABLE items ADD COLUMN bin_code TEXT;`. Existing items have no bin until a clerk sets one.",
          "files": [
            "migrations/003_item_bin_code.sql"
          ],
          "test_scenarios": [
            "migrate applies cleanly to an empty database."
          ]
        },
        {
          "id": "t2",
          "description": "Add src/bins.ts with `isBinCode(code: string): boolean`, which tests `/^[A-Z]-\\d{2}-\\d$/`. Add `setBinCode(sku: string, binCode: string | null): Promise<boolean>` to ItemRepo, returning false for an unknown sku. SqlItemRepo runs `UPDATE items SET bin_code = ? WHERE sku = ?` and returns whether a row changed; MemoryItemRepo updates binCode on every stored line of that sku.",
          "files": [
            "src/bins.ts",
            "src/items.ts",
            "tests/memory-item-repo.ts",
            "tests/bins.test.ts"
          ],
          "test_scenarios": [
            "isBinCode accepts A-03-2 and rejects a-03-2, A-3-2, A-03-12, and the empty string."
          ]
        },
        {
          "id": "t3",
          "description": "Add `putItemBin(repo, sku, body)` in src/routes.ts for PUT /items/:sku/bin with body `{ binCode: string | null }`. A string that fails isBinCode is a 400 with the message `Bin codes look like A-03-2`; null clears the bin; an unknown sku is a 404; success is 204.",
          "files": [
            "src/routes.ts",
            "tests/routes.test.ts"
          ],
          "test_scenarios": [
            "PUT A-03-2 for a known sku returns 204 and the next pick list shows A-03-2 (MemoryItemRepo).",
            "PUT null clears the bin and the pick list shows -.",
            "PUT A-3-2 returns 400 with the message.",
            "PUT for an unknown sku returns 404."
          ]
        }
      ],
      "verification": "bun test",
      "qualitative_verification": "On the staging terminal, set a bin for one item and print a pick list that contains it."
    }
  ],
  "success_criteria": [
    "Every pick-list line shows its item's bin code, or - when the item has none.",
    "A clerk can set and clear an item's bin; malformed codes are rejected with a message.",
    "The pick-list line order is unchanged.",
    "bun test passes."
  ],
  "open_questions": [],
  "implementation_contract": {
    "directives": [
      {
        "id": "d1",
        "text": "The pick list shows bin codes.",
        "completion_check": "tests/picklist.test.ts covers a line with a bin and a line without one."
      },
      {
        "id": "d2",
        "text": "PUT /items/:sku/bin sets, clears, and validates bin codes.",
        "completion_check": "tests/routes.test.ts covers set, clear, malformed, and unknown sku."
      }
    ]
  }
}
