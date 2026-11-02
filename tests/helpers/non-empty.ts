import { Array as Arr } from "effect"

/** `list` as a non-empty list, for a test that builds a definition from
 *  phases that a filter or a map produced. Throws when it is empty. */
export function nonEmpty<T>(list: readonly T[]): readonly [T, ...T[]] {
  if (!Arr.isReadonlyArrayNonEmpty(list)) throw new Error("expected a non-empty list")
  return list
}
