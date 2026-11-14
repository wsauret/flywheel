import type { Recipe } from "../recipes";
import { escapeHtml } from "./html";
import { renderIngredients } from "./ingredients";

export function renderRecipePage(recipe: Recipe): string {
  return [
    `<h1>${escapeHtml(recipe.title)}</h1>`,
    `<p class="servings">Serves ${recipe.servings}</p>`,
    renderIngredients(recipe),
    `<ol class="steps">${recipe.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>`,
  ].join("\n");
}
