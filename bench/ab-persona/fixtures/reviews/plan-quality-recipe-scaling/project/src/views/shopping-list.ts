import type { Recipe } from "../recipes";
import { escapeHtml } from "./html";
import { renderIngredients } from "./ingredients";

/** The printable shopping list for the recipes a reader saved: one section per recipe. */
export function renderShoppingList(recipes: readonly Recipe[]): string {
  return recipes.map((recipe) => `<section><h2>${escapeHtml(recipe.title)}</h2>\n${renderIngredients(recipe)}</section>`).join("\n");
}
