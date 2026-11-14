import type { RecipeStore } from "../recipes";
import { renderRecipePage } from "../views/recipe-page";

export interface PageResponse {
  readonly status: number;
  readonly html: string;
}

/** GET /recipes/:id */
export async function getRecipePage(store: RecipeStore, id: string): Promise<PageResponse> {
  const recipe = await store.get(id);
  if (recipe === undefined) return { status: 404, html: "<h1>Recipe not found</h1>" };
  return { status: 200, html: renderRecipePage(recipe) };
}
