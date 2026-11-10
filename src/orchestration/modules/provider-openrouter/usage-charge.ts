import { asRecord } from "../../../infra/record.js";

function amount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The amount in USD that an OpenRouter response's usage states as charged for the request, or undefined when the
 *  response states none. `usage.cost` is the amount charged to the OpenRouter account. When the request ran on the
 *  account's own provider key (`usage.is_byok`), `cost` is only OpenRouter's fee and the upstream provider bills
 *  `cost_details.upstream_inference_cost` separately, so the charge is their sum. */
export function openRouterReportedChargeUsd(usage: unknown): number | undefined {
  const fields = asRecord(usage);
  const cost = amount(fields?.cost);
  if (cost === undefined || fields?.is_byok !== true) return cost;
  const upstream = amount(asRecord(fields.cost_details)?.upstream_inference_cost);
  return upstream === undefined ? undefined : cost + upstream;
}
