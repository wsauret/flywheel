/** Freezes `value` and every object reachable through its own enumerable
 *  properties, in place, and returns it. A value that many readers share
 *  is frozen so that no reader can change what the others read. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
