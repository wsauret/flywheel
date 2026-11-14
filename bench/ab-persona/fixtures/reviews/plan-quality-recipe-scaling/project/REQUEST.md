# Request: scale a recipe to a number of servings

From the school's editor.

Readers cook for more or fewer people than a recipe serves, and they do the arithmetic by hand.

1. The recipe page has a servings selector from 1 to 24. Choosing a number shows every ingredient amount scaled to it.
2. The choice is kept in the address as `?servings=N`, so a shared link shows the same amounts. A missing or invalid value shows the recipe as written.
3. Amounts stay easy to measure: kitchen measures in quarters, never a zero for an ingredient the recipe needs, and whole pieces (no half eggs).

Out of scope: the shopping list keeps the recipe's own amounts. A separate request will scale it and combine equal ingredients across recipes.
