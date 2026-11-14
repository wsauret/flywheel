import type { Unit } from "./recipes";

const FRACTIONS: Record<number, string> = { 0.25: "1/4", 0.5: "1/2", 0.75: "3/4" };
const KITCHEN_MEASURES: readonly Unit[] = ["cup", "tbsp", "tsp"];

function quarters(amount: number): string {
  const rounded = Math.max(0.25, Math.round(amount * 4) / 4);
  const whole = Math.floor(rounded);
  const fraction = FRACTIONS[rounded - whole];
  if (fraction === undefined) return String(whole);
  return whole === 0 ? fraction : `${whole} ${fraction}`;
}

/** An amount as a cook reads it. Kitchen measures round to the nearest quarter, but a positive
 *  amount never shows below 1/4; grams and millilitres round to whole numbers, at least 1;
 *  pieces round up to a whole piece. */
export function formatQuantity(amount: number, unit: Unit): string {
  if (KITCHEN_MEASURES.includes(unit)) return `${quarters(amount)} ${unit}`;
  if (unit === "piece") return String(Math.ceil(amount));
  return `${Math.max(1, Math.round(amount))} ${unit}`;
}
