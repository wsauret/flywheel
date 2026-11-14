import { formatQuantity } from "../quantity";
import type { Recipe } from "../recipes";
import { escapeHtml } from "./html";

/** The ingredient list of a recipe, amounts as written. */
export function renderIngredients(recipe: Recipe): string {
  const items = recipe.ingredients.map((ingredient) => `<li>${formatQuantity(ingredient.amount, ingredient.unit)} ${escapeHtml(ingredient.name)}</li>`);
  return `<ul class="ingredients">${items.join("")}</ul>`;
}
