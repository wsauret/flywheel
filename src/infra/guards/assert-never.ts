/** Exhaustiveness helper for discriminated-union narrowing.
 *
 *  Place at the `default` branch of a switch on a finite union; TypeScript
 *  will fail compilation at every call site if the union gains a new variant.
 *  Throws at runtime if reached via untyped code paths. The value is serialized
 *  with `JSON.stringify` so the message names the offending variant (not
 *  `[object Object]`) for the object-shaped unions this guards.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled discriminant: ${JSON.stringify(value)}`);
}
