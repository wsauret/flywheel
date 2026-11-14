# hearth-and-spoon

The recipe site of the Hearth & Spoon cookery school. Pages are rendered on the server as HTML.

- `src/recipes.ts` holds recipes.
- `src/quantity.ts` formats an ingredient amount for people who cook: kitchen measures as fractions, weights and volumes as whole numbers.
- `src/views/` renders the recipe page, the ingredient list, and the shopping list.
- `src/web/routes.ts` is the HTTP surface.

Tests run with `bun test`.
