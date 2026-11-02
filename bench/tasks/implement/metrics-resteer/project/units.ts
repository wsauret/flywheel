import type { MetricUnit } from "./types.js";

export function normalizeUnit(value: number): number {
  return value;
}

export function secondsToMilliseconds(value: number): number {
  return value * 1_000;
}

export const UNIT_NORMALIZERS: Readonly<Record<MetricUnit, (value: number) => number>> = {
  ms: normalizeUnit,
  s: secondsToMilliseconds,
  count: normalizeUnit,
};
