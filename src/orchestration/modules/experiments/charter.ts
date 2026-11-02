import { parseMetricLines } from "./metric-lines.js"
import type { MetricDirection } from "./types.js"

/** Where the approved charter lives, relative to the experiment work directory. */
export const EXPERIMENT_CHARTER_PATH = ".experiment/charter.md"

/** Paths every initialized experiment protects in addition to the charter's own list. */
export const MANDATORY_PROTECTED_PATHS = [
  EXPERIMENT_CHARTER_PATH,
  ".experiment/measure.sh",
  ".experiment/checks.sh",
] as const

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  "name", "metric_name", "metric_unit", "direction", "measure_command",
  "checks_command", "work_dir", "max_iterations", "protected_paths", "sealed_paths",
])

/** One parsed TOML table before any field is validated. */
interface TomlTable {
  readonly [key: string]: unknown
}

const REQUIRED_SECTIONS = [
  "Objective", "Metrics", "Hard gates", "Anti-gaming rules", "Files in scope",
  "Protected paths", "Sealed paths", "Commands", "Baseline", "Search strategy",
] as const

export interface ExperimentCharter {
  readonly name: string
  readonly metricName: string
  readonly metricUnit: string
  readonly direction: MetricDirection
  readonly measureCommand: string
  readonly checksCommand: string | null
  readonly workDir: string
  readonly maxIterations: number | null
  readonly protectedPaths: readonly string[]
  readonly sealedPaths: readonly string[]
  readonly baselineMetric: number
}

/** Parses the approved charter boundary. It rejects unknown configuration,
 * incomplete prose, and a baseline that does not prove the primary metric. */
export function parseExperimentCharter(markdown: string): ExperimentCharter {
  const blocks = [...markdown.matchAll(/```toml\s*\n([\s\S]*?)```/g)]
  if (blocks.length !== 1) throw new Error("The charter must contain exactly one TOML configuration block.")
  let raw: unknown
  try {
    raw = Bun.TOML.parse(blocks[0]?.[1] ?? "")
  } catch (error) {
    throw new Error(`The charter TOML is malformed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (!isTomlTable(raw)) throw new Error("The charter TOML must be a table.")
  const unknown = Object.keys(raw).filter((key) => !CONFIG_KEYS.has(key))
  if (unknown.length > 0) throw new Error(`The charter TOML contains unknown field: ${unknown.join(", ")}.`)
  for (const section of REQUIRED_SECTIONS) {
    const match = markdown.match(sectionPattern(section))
    if (!match?.[1]?.trim()) throw new Error(`The charter requires a non-empty ${section} section.`)
  }

  const name = requiredString(raw.name, "name")
  const metricName = requiredString(raw.metric_name, "metric_name")
  const metricUnit = requiredString(raw.metric_unit, "metric_unit", true)
  const direction = raw.direction
  if (direction !== "lower" && direction !== "higher") throw new Error("direction must be lower or higher.")
  const measureCommand = requiredString(raw.measure_command, "measure_command")
  const checksCommand = nullableString(raw.checks_command, "checks_command")
  const workDir = requiredString(raw.work_dir, "work_dir")
  const maxIterations = nullablePositiveInteger(raw.max_iterations, "max_iterations")
  const protectedPaths = stringList(raw.protected_paths, "protected_paths")
  const sealedPaths = stringList(raw.sealed_paths, "sealed_paths")
  const metrics = parseMetricLines(sectionBody(markdown, "Baseline"))
  const baselineMetric = metrics.get(metricName)
  if (baselineMetric === undefined) throw new Error(`The Baseline section must contain an observed METRIC ${metricName}=... line.`)
  return { name, metricName, metricUnit, direction, measureCommand, checksCommand, workDir, maxIterations, protectedPaths, sealedPaths, baselineMetric }
}

function sectionBody(markdown: string, heading: string): string {
  return markdown.match(sectionPattern(heading))?.[1] ?? ""
}

function requiredString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw new Error(`${field} must be a${allowEmpty ? "" : " non-empty"} string.`)
  return value
}

function nullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  return requiredString(value, field)
}

function nullablePositiveInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer.`)
  return value
}

function stringList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`${field} must be an array of non-empty strings.`)
  }
  return value
}

function isTomlTable(value: unknown): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function sectionPattern(heading: string): RegExp {
  return new RegExp(`^## ${escapeRegex(heading)}\\s*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m")
}
