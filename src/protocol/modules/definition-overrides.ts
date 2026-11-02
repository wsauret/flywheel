import { Schema } from "effect"
import { defineProtocolDomain, defineProtocolModule, type ModuleRow } from "../protocol-module.js"
import type { RuntimePosition } from "../runtime-ui-protocol-types.js"

/** The workspace-scoped `definitionStaleness` contract: every user or project
 *  definition that overrides a bundled default and is in effect, whether the
 *  default has moved on since the override was taken, and the diagnostics the
 *  definition loader raised. A rejected override appears only as a diagnostic. Derived from the same lossless resolution records that selected the
 *  runtime's definitions, so the view and the agent's tool never disagree. */

type RuntimeDefinitionStalenessStatus = "current" | "upstream-changed"

interface RuntimeDefinitionDiagnostic {
  readonly path: string
  readonly layer: "bundled" | "user" | "project"
  readonly message: string
}

interface RuntimeDefinitionOverride {
  readonly family: "skill" | "persona" | "system-prompt"
  readonly id: string
  readonly layer: "user" | "project"
  readonly path: string
  readonly status: RuntimeDefinitionStalenessStatus
  readonly snapshotAvailable: boolean
}

export interface RuntimeDefinitionStalenessView {
  readonly overrides: readonly RuntimeDefinitionOverride[]
  readonly diagnostics: readonly RuntimeDefinitionDiagnostic[]
  /** How many overrides have an upstream update waiting for review. */
  readonly reviewCount: number
}

interface RuntimeDefinitionStalenessSnapshotResult {
  readonly snapshotPosition: RuntimePosition
  readonly definitionStaleness: RuntimeDefinitionStalenessView
}

type DefinitionStalenessPatchPayload = { readonly kind: "definitionStaleness.changed"; readonly definitionStaleness: RuntimeDefinitionStalenessView }

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const RuntimeDefinitionStalenessViewSchema: Schema.Codec<RuntimeDefinitionStalenessView> = Schema.Struct({
  overrides: Schema.Array(Schema.Struct({
    family: Schema.Literals(["skill", "persona", "system-prompt"]),
    id: Schema.String,
    layer: Schema.Literals(["user", "project"]),
    path: Schema.String,
    status: Schema.Literals(["current", "upstream-changed"]),
    snapshotAvailable: Schema.Boolean,
  })),
  diagnostics: Schema.Array(Schema.Struct({ path: Schema.String, layer: Schema.Literals(["bundled", "user", "project"]), message: Schema.String })),
  reviewCount: NonNegativeInt,
})
const RuntimeDefinitionStalenessSnapshotResultSchema: Schema.Codec<RuntimeDefinitionStalenessSnapshotResult> = Schema.Struct({ snapshotPosition: Schema.Number, definitionStaleness: RuntimeDefinitionStalenessViewSchema })
const DefinitionStalenessPatchPayloadSchema: Schema.Codec<DefinitionStalenessPatchPayload> = Schema.Struct({ kind: Schema.Literal("definitionStaleness.changed"), definitionStaleness: RuntimeDefinitionStalenessViewSchema })

const definitionStalenessDomain = defineProtocolDomain({
  domain: "definitionStaleness",
  scope: "workspace",
  // One patch carries the whole report, so the newest supersedes any it overtook.
  delivery: "latest-collapsible",
  content: "whole-value",
  snapshot: { query: "definitionStalenessSnapshot", result: RuntimeDefinitionStalenessSnapshotResultSchema, deadline: "control" },
  patch: DefinitionStalenessPatchPayloadSchema,
  view: { snapshot: (result) => result.definitionStaleness, patch: (payload) => payload.definitionStaleness },
})

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

/** The status row: what is overridden, what waits for review, and what the
 *  loader could not read, with each path spelled out in the hint. */
function statusRow(view: RuntimeDefinitionStalenessView): ModuleRow {
  const problems = view.diagnostics.length
  if (problems === 0 && view.overrides.length === 0 && view.reviewCount === 0) return { id: "definition-overrides", label: "Definitions", value: "all current" }
  const value = [
    view.overrides.length > 0 ? `${view.overrides.length} overridden` : undefined,
    view.reviewCount > 0 ? `${view.reviewCount} to review` : undefined,
    problems > 0 ? plural(problems, "problem") : undefined,
  ].filter((part) => part !== undefined).join(", ")
  const hint = [
    ...view.diagnostics.map((diagnostic) => `${diagnostic.path} (${diagnostic.layer}): ${diagnostic.message}`),
    ...view.overrides.map((override) => `${override.family} ${override.id} overridden by the ${override.layer} copy at ${override.path}`),
  ].join("\n")
  return { id: "definition-overrides", label: "Definitions", value, ...(hint.length > 0 ? { hint } : {}), ...(problems > 0 ? { tone: "warning" } : {}) }
}

export const definitionOverridesProtocol = defineProtocolModule({
  id: "definition-overrides",
  domains: [definitionStalenessDomain],
  rows: {
    intro: (read) => {
      const reviewCount = read(definitionStalenessDomain)?.reviewCount ?? 0
      return reviewCount === 0 ? [] : [{ id: "definition-overrides", label: "overrides", value: `${reviewCount} with upstream updates`, hint: "ask to review them" }]
    },
    status: (read) => {
      const view = read(definitionStalenessDomain)
      return view === undefined ? [] : [statusRow(view)]
    },
  },
})
