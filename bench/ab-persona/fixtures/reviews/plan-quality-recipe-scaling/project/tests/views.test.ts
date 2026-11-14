import { expect, test } from "bun:test";
import { renderRecipePage } from "../src/views/recipe-page";
import { renderShoppingList } from "../src/views/shopping-list";

export const pancakes = {
  id: "r-1",
  title: "Pancakes",
  servings: 4,
  ingredients: [
    { name: "flour", amount: 1.5, unit: "cup" as const },
    { name: "eggs", amount: 2, unit: "piece" as const },
    { name: "milk", amount: 300, unit: "ml" as const },
  ],
  steps: ["Whisk.", "Fry."],
};

test("the recipe page lists the ingredients as written", () => {
  const html = renderRecipePage(pancakes);
  expect(html).toContain("<li>1 1/2 cup flour</li>");
  expect(html).toContain("Serves 4");
});

test("the shopping list lists each recipe's ingredients", () => {
  expect(renderShoppingList([pancakes])).toContain("<li>300 ml milk</li>");
});
