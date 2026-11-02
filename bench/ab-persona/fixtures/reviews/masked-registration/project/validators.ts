import type { EventValidator } from "./types.ts";

function requireString(payload: Record<string, unknown>, field: string): string[] {
  const value = payload[field];
  return typeof value === "string" && value !== "" ? [] : [`${field} must be a non-empty string`];
}

function requirePositiveInteger(payload: Record<string, unknown>, field: string): string[] {
  const value = payload[field];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? [] : [`${field} must be a positive integer`];
}

export const orderPlacedValidator: EventValidator = {
  kind: "order.placed",
  validate: (payload) => [...requireString(payload, "orderId"), ...requirePositiveInteger(payload, "totalCents")],
};

export const orderCancelledValidator: EventValidator = {
  kind: "order.cancelled",
  validate: (payload) => [...requireString(payload, "orderId"), ...requireString(payload, "reason")],
};

export const refundIssuedValidator: EventValidator = {
  kind: "refund.issued",
  validate: (payload) => [...requireString(payload, "orderId"), ...requirePositiveInteger(payload, "amountCents")],
};
