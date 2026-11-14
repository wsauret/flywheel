export type Unit = "g" | "ml" | "cup" | "tbsp" | "tsp" | "piece";

export interface Ingredient {
  readonly name: string;
  readonly amount: number;
  readonly unit: Unit;
}

export interface Recipe {
  readonly id: string;
  readonly title: string;
  readonly servings: number;
  readonly ingredients: readonly Ingredient[];
  readonly steps: readonly string[];
}

export interface RecipeStore {
  get(id: string): Promise<Recipe | undefined>;
}
