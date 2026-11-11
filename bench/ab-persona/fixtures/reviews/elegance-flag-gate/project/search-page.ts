import type { FeatureGate } from "./feature-gate.ts";

export function searchRanker(gate: FeatureGate, userId: string): "classic" | "semantic" {
  return gate.isOn("semantic-search", userId) ? "semantic" : "classic";
}
