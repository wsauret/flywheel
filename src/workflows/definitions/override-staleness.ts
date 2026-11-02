import { existsSync } from "node:fs"
import { dirname, join } from "node:path"

import type { BundledDefaultCatalog } from "./bundled-defaults.js"
import type { DefinitionFamily, DefinitionLayer, DefinitionResolution } from "../../infra/definition-resolution.js"
import type { DefinitionOverrideBaselineRecords } from "./override-baselines.js"

import type { MutationDiff } from "../../infra/mutation-diff.js"
export type DefinitionStalenessStatus = "current" | "upstream-changed"
export type OverrideResolutionAction = "keep-mine" | "adopt-default" | "rebase"

interface BoundOverrideTarget {
  readonly family: DefinitionFamily
  readonly id: string
  readonly path: string
  readonly layer: Exclude<DefinitionLayer, "bundled">
}

export type PreparedOverrideTarget =
  | (BoundOverrideTarget & {
      readonly kind: "single-file"
      readonly overrideIdentity: string
      readonly currentDefaultIdentity: string
      readonly snapshotIdentity?: string
    })
  | (BoundOverrideTarget & {
      readonly kind: "skill-package"
      readonly reach: "global" | "project"
      readonly overridePackageIdentity: string
      readonly currentDefaultPackageIdentity: string
      readonly snapshotPackageIdentity?: string
    })

interface OverridePackageFiles {
  readonly [path: string]: string
}

export type CompleteOverrideContent =
  | { readonly kind: "single-file"; readonly content: string }
  | { readonly kind: "skill-package"; readonly files: OverridePackageFiles }

export type OverrideRebaseSource =
  | { readonly kind: "verified-three-way"; readonly base: CompleteOverrideContent; readonly theirs: CompleteOverrideContent; readonly mine: CompleteOverrideContent }
  | { readonly kind: "missing-base"; readonly theirs: CompleteOverrideContent; readonly mine: CompleteOverrideContent; readonly mineVersusTheirs: MutationDiff; readonly reason: string }

export interface PreparedOverrideResolution {
  readonly preparationId: string
  readonly action: OverrideResolutionAction
  readonly target: PreparedOverrideTarget
  readonly source?: OverrideRebaseSource
  readonly proposed?: CompleteOverrideContent
  readonly diff?: MutationDiff
  /** Writer-owned Markdown that the person reads before approving: the action, the override it changes, and the diff approval applies. */
  readonly summary?: string
}

interface DefinitionDiagnostic {
  readonly path: string
  readonly layer: DefinitionLayer
  readonly message: string
}


export interface DefinitionOverride {
  readonly family: DefinitionFamily
  readonly id: string
  readonly layer: Exclude<DefinitionLayer, "bundled">
  readonly path: string
  readonly catalogPath: string
  readonly status: DefinitionStalenessStatus
  /** False when the loader rejected this copy. A diagnostic then says why, and
   *  a lower copy runs in its place. The override stays in the report, so the
   *  agent can still repair it or adopt the default. */
  readonly valid: boolean
  readonly baseDefaultHash?: string
  readonly currentDefaultHash: string
  readonly snapshotPath: string
  readonly snapshotAvailable: boolean
}

export interface DefinitionStalenessReport {
  readonly overrides: readonly DefinitionOverride[]
  readonly diagnostics: readonly DefinitionDiagnostic[]
}

export interface DefinitionOverrideOperations {
  /** True only while the latest report contains an unresolved definition conflict. */
  available(): boolean
  list(): Promise<DefinitionStalenessReport>
  /** Observe every reload of the report, so a projection publishes what the
   *  operations themselves read and never derives a second copy. */
  subscribe(listener: (report: DefinitionStalenessReport) => void): () => void
  diff(path: string): Promise<MutationDiff>
  prepare(path: string, action: OverrideResolutionAction, proposed?: CompleteOverrideContent): Promise<PreparedOverrideResolution>
  apply(preparation: PreparedOverrideResolution): Promise<void>
  refresh(): Promise<void>
  proposal(preparationId: string): PreparedOverrideResolution | undefined
  finalizeSkillPublication(preparation: PreparedOverrideResolution): Promise<void>
}

/** Derive override staleness from the same lossless records that selected the
 * runtime definitions. No directory is rediscovered here. */
export function deriveDefinitionStalenessReport(
  resolutions: readonly DefinitionResolution<unknown>[],
  catalog: BundledDefaultCatalog,
  baselines: DefinitionOverrideBaselineRecords = {},
): DefinitionStalenessReport {
  const overrides: DefinitionOverride[] = []
  const diagnostics: DefinitionDiagnostic[] = []
  for (const resolution of resolutions) {
    const currentDefault = catalog.files[resolution.target]
    for (const candidate of resolution.candidates) {
      if (candidate.source.layer === "bundled") continue
      if (candidate.kind === "rejected") diagnostics.push({ path: candidate.source.path, layer: candidate.source.layer, message: candidate.reason })
      // An override is purely positional: a non-bundled definition that sits
      // at the catalog path of a bundled default. A definition with no bundled
      // counterpart is the user's own and never needs review.
      if (!currentDefault) continue
      const baseDefaultHash = baselines[candidate.source.path]?.acknowledged_default_hash
      const snapshotPath = snapshotPathFor(resolution.family, candidate.source.path)
      overrides.push({
        family: resolution.family,
        id: resolution.id,
        layer: candidate.source.layer,
        path: candidate.source.path,
        catalogPath: resolution.target,
        status: classifyOverride(baseDefaultHash, currentDefault.baseDefaultHash),
        valid: candidate.kind === "valid",
        ...(baseDefaultHash ? { baseDefaultHash } : {}),
        currentDefaultHash: currentDefault.baseDefaultHash,
        snapshotPath,
        snapshotAvailable: existsSync(snapshotPath),
      })
    }
  }
  return { overrides, diagnostics }
}
export function classifyOverride(base: string | undefined, currentDefaultHash: string): DefinitionStalenessStatus {
  return base === currentDefaultHash ? "current" : "upstream-changed"
}


function snapshotPathFor(family: DefinitionFamily, overridePath: string): string {
  return family === "skill" ? join(dirname(overridePath), ".base") : `${overridePath}.base`
}
