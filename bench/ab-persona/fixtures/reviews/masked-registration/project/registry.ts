import type { EventKind, EventValidator } from "./types.ts";
import { orderCancelledValidator, orderPlacedValidator, refundIssuedValidator } from "./validators.ts";

/** Build a kind-keyed validator registry. Duplicate kinds are rejected so a
 *  wiring mistake fails at construction instead of shadowing a validator. */
export function createValidatorRegistry(validators: readonly EventValidator[]): ReadonlyMap<EventKind, EventValidator> {
  const registry = new Map<EventKind, EventValidator>();
  for (const validator of validators) {
    if (registry.has(validator.kind)) {
      throw new Error(`Duplicate validator registered for ${validator.kind}`);
    }
    registry.set(validator.kind, validator);
  }
  return registry;
}

/** Every validator the deployed service registers. Both production consumers,
 *  the live ingest handler and the nightly backfill job, read this registry. */
export const PRODUCTION_VALIDATORS = createValidatorRegistry([
  orderPlacedValidator,
  orderCancelledValidator,
  refundIssuedValidator,
]);
