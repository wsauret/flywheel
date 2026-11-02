import type { ModuleConfigNumberListControl } from "../module-protocol-types.js"

/** The word an empty list reads as: an empty list turns the setting off. */
const OFF = "Off"

/** A module number list as every client shows it: each value with the
 *  control's suffix, or Off for an empty list. */
export function formatModuleNumberList(values: readonly number[], control: Pick<ModuleConfigNumberListControl, "suffix">): string {
  return values.length === 0 ? OFF : values.map((value) => `${value}${control.suffix ?? ""}`).join(", ")
}

/** Parses the comma-separated list a module setting accepts. Empty text or
 *  Off disables the list; values must be increasing integers inside its
 *  bounds. */
export function parseModuleNumberList(text: string, control: Pick<ModuleConfigNumberListControl, "min" | "max">): readonly number[] | undefined {
  if (text.trim() === "" || text.trim().toLowerCase() === OFF.toLowerCase()) return []
  const pieces = text.split(",").map((part) => part.trim())
  if (pieces.some((part) => !/^\d+$/.test(part))) return undefined
  const values = pieces.map(Number)
  return values.every((value, index) => {
    const previous = values[index - 1]
    return Number.isSafeInteger(value) && value >= control.min && value <= control.max && (index === 0 || (previous !== undefined && value > previous))
  }) ? values : undefined
}
