{
  "schema_version": 1,
  "summary": "Scale a recipe on its page to the servings the reader picks, as REQUEST.md asks. The route reads ?servings, the recipe page shows a selector and the scaled amounts, and the existing quantity formatting keeps the amounts easy to measure. The shopping list stays as it is.",
  "context": {
    "key_files": [
      "REQUEST.md - The editor's request, with the shopping list out of scope.",
      "src/quantity.ts - formatQuantity. Kitchen measures round to the nearest quarter and never show below 1/4 for a positive amount; grams and millilitres round to whole numbers, at least 1; pieces round up. This already meets rule 3 of the request for any scaled amount.",
      "src/views/ingredients.ts - renderIngredients(recipe), called by the recipe page and by the shopping list.",
      "src/views/recipe-page.ts - renderRecipePage.",
      "src/views/shopping-list.ts - renderShoppingList, which must keep the recipe's own amounts.",
      "src/web/routes.ts - getRecipePage for GET /recipes/:id.",
      "tests/quantity.test.ts, tests/views.test.ts - Existing coverage, including the rounding floors."
    ],
    "patterns": [
      "Views are pure functions from data to HTML strings.",
      "User text in HTML goes through escapeHtml in src/views/html.ts."
    ],
    "constraints": [
      "The shopping list keeps the recipe's own amounts (REQUEST.md, out of scope).",
      "A missing or invalid ?servings shows the recipe as written."
    ],
    "project_docs": [
      "README.md",
      "REQUEST.md"
    ]
  },
  "phases": [
    {
      "id": "phase-1",
      "goal": "Scaled amounts on the recipe page.",
      "files": [
        "src/views/ingredients.ts",
        "src/views/recipe-page.ts",
        "src/web/routes.ts",
        "tests/views.test.ts",
        "tests/routes.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Give renderIngredients an optional second parameter, `servings: number = recipe.servings`, and format `ingredient.amount * servings / recipe.servings`. The shopping list keeps calling renderIngredients(recipe), so its amounts do not change, which is what the request asks.",
          "files": [
            "src/views/ingredients.ts",
            "tests/views.test.ts"
          ],
          "test_scenarios": [
            "Pancakes for 4 shown for 2: 3/4 cup flour and 150 ml milk.",
            "Pancakes for 4 shown for 3: 2 eggs, because 1.5 eggs round up to a whole piece.",
            "The shopping list still shows 300 ml milk for the same recipe."
          ]
        },
        {
          "id": "t2",
          "description": "Give renderRecipePage a `servings` parameter, defaulting to recipe.servings. It shows `Serves N` with the chosen N, passes N to renderIngredients, and renders a GET form with a `<select name=\"servings\" onchange=\"this.form.submit()\">` of 1 to 24 with N selected, plus a Show button for readers without scripts, so choosing a number reloads the page with ?servings=N.",
          "files": [
            "src/views/recipe-page.ts",
            "tests/views.test.ts"
          ],
          "test_scenarios": [
            "For servings 6 the page shows Serves 6, 2 1/4 cup flour, and option 6 selected.",
            "The selector offers 1 to 24."
          ]
        },
        {
          "id": "t3",
          "description": "Add `parseServings(raw: string | null): number | undefined` in src/web/routes.ts: an integer string from 1 to 24 gives the number; anything else gives undefined. getRecipePage takes the query value and passes `parseServings(raw) ?? recipe.servings` to renderRecipePage.",
          "files": [
            "src/web/routes.ts",
            "tests/routes.test.ts"
          ],
          "test_scenarios": [
            "parseServings accepts 1 and 24 and rejects 0, 25, 2.5, abc, and null.",
            "GET /recipes/r-1?servings=2 shows Serves 2; ?servings=abc shows the recipe as written."
          ]
        }
      ],
      "verification": "bun test",
      "qualitative_verification": "Open a recipe locally, pick 2 and 12 servings, and copy the address into a new window."
    }
  ],
  "success_criteria": [
    "A reader can scale a recipe from 1 to 24 servings on its page, and the address keeps the choice.",
    "Scaled amounts are in quarters, never zero, and in whole pieces.",
    "The shopping list is unchanged.",
    "bun test passes."
  ],
  "open_questions": [],
  "implementation_contract": {
    "directives": [
      {
        "id": "d1",
        "text": "The recipe page scales every amount to ?servings within 1 to 24.",
        "completion_check": "tests/views.test.ts and tests/routes.test.ts cover a scaled page, an invalid value, and the selector."
      },
      {
        "id": "d2",
        "text": "The shopping list keeps the recipe's own amounts.",
        "completion_check": "tests/views.test.ts asserts the shopping list after the change."
      }
    ]
  }
}
