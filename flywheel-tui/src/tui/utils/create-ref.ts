/**
 * createRef — Tiny helper for getter-based mutable refs.
 *
 * Replaces the verbose `Object.defineProperty({}, "current", { get, set })` pattern
 * used throughout the shell to bridge SolidJS signals with injected-dependency code
 * that expects `{ current: T }` refs.
 *
 * Usage:
 *   const ref = createRef(() => lifecycle.getActiveSession(), (v) => lifecycle.setActiveSession(v))
 *   // ref.current reads/writes through the getter/setter
 */

/**
 * Create a `{ current: T }` ref backed by a getter and optional setter.
 * Reading `ref.current` calls `get()`; writing `ref.current = v` calls `set(v)`.
 * If no setter is provided, writes are silently ignored.
 */
export function createRef<T>(get: () => T, set?: (v: T) => void): { current: T } {
  return Object.defineProperty({} as { current: T }, "current", {
    get,
    set: set ?? (() => {}),
  })
}
