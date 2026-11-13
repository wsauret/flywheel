export const TIERS = [
  { name: "gold", minPoints: 5000, discount: 0.1 },
  { name: "silver", minPoints: 1000, discount: 0.05 },
  { name: "bronze", minPoints: 0, discount: 0 },
] as const;

export type Tier = (typeof TIERS)[number]["name"];

/** The tier a balance earns. TIERS is ordered from the highest threshold down. */
export function tierFor(points: number): Tier {
  for (const tier of TIERS) {
    if (points >= tier.minPoints) return tier.name;
  }
  return "bronze";
}

export function discountFor(tier: Tier): number {
  return TIERS.find((candidate) => candidate.name === tier)?.discount ?? 0;
}
