# plan-quality-recipe-scaling: control

This fixture seeds no defect. The plan is complete and every claim it makes about the code holds. It contains choices that a reflexive plan reviewer tends to flag; each is correct here.

## Tempting findings that are wrong

- "renderIngredients has two callers and the plan updates only one; the shopping list is missed." The new parameter is optional and defaults to recipe.servings, so the shopping list's call renders exactly what it renders today. REQUEST.md puts shopping-list scaling out of scope, so leaving that call alone is the requirement, and the plan adds a test that the shopping list is unchanged.
- "formatQuantity can show 0 for a small scaled amount" or "can show half an egg." It cannot: quarters() floors positive kitchen measures at 1/4, grams and millilitres are at least 1, and pieces use Math.ceil. tests/quantity.test.ts asserts each floor (0.05 tsp is 1/4 tsp, 0.3 ml is 1 ml, 0.5 piece is 1). The plan's claim that rule 3 is already met holds, so no rounding work is missing.
- "The plan adds no tests for rounding." The rounding is existing behavior with existing tests; the plan's scaling scenarios (3/4 cup, 2 eggs from 1.5) exercise it through the new path.
- "parseServings does not handle 2.5 or 0." Its scenarios list 0, 25, 2.5, abc, and null.
- "The tests are thin." Each requirement has a scenario: scaled amounts, the 1 to 24 selector, the address parameter with a valid and an invalid value, and the unchanged shopping list.
- "The servings value is not escaped in the HTML." It is a number from parseServings or from the recipe, never raw query text.
- "The selector needs a script." The plan adds a Show button, so the GET form works without one.
