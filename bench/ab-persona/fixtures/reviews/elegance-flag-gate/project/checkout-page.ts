import type { FeatureGate } from "./feature-gate.ts";

export interface CheckoutOptions {
  oneClick: boolean;
  expressShipping: boolean;
}

export function checkoutOptions(gate: FeatureGate, userId: string): CheckoutOptions {
  return {
    oneClick: gate.isOn("one-click-checkout", userId),
    expressShipping: gate.isOn("express-shipping", userId),
  };
}
