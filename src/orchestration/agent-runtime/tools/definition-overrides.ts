import type { CompleteOverrideContent, DefinitionOverrideOperations, OverrideResolutionAction, PreparedOverrideResolution } from "../../../workflows/definitions/override-staleness.js"
import { claimAnsweredDecision } from "../../session/agent-input-decision.js"
import { packagePathRefusal } from "../../../workflows/skill-package-path.js"
import type { ManagedPackageMutation, ManagedPackageReach, ManagedPackageWrites } from "../../module-seams.js"
import type { AdvertisedTool, RuntimeTool } from "./types.js"

interface DefinitionOverrideInput {
  [key: string]: unknown;
}

const INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["list", "diff", "keep-mine", "adopt-default", "rebase"] },
    path: { type: "string" },
    preparation_id: { type: "string" },
    confirmation_id: { type: "string" },
    merged_content: { type: "string", description: "Complete merged bytes for a single-file override." },
    merged_files: { type: "object", additionalProperties: { type: "string" }, description: "Complete package-relative path-to-byte map for a skill package." },
  },
} as const

export interface DefinitionOverridesToolDeps {
  readonly service: DefinitionOverrideOperations
  readonly packages?: ManagedPackageWrites
  readonly askUserAvailable?: boolean
  /** Whether the agent has `message_session`, its channel to its parent. */
  readonly parentChannel?: boolean
}

/** Only a root chat asks the person (PI-AGENT-024), so a child reaches the
 *  approval through its parent. The words name `message_session` only when
 *  the agent has it; without it no parent can answer, so the child decides
 *  alone and states its assumptions. */
function resolutionNeedsThePerson(parentChannel: boolean): string {
  const child = parentChannel
    ? "In a child session, message your parent with message_session and ask it to resolve the override."
    : "In a child session, no parent can answer during this run: leave the override unresolved, decide on your own judgment, and state in your handoff that the override needs the person's approval and each assumption that you made."
  return `Resolving an override requires the Ask User capability, because the person approves it. In a root chat, enable Ask User and retry. ${child}`
}

/** The definition_overrides tool as the model sees it. Whether this agent can
 *  ask the person, and whether it has a parent to ask, decide only what a
 *  resolving call returns, so every agent advertises the same bytes. */
export const DEFINITION_OVERRIDES_TOOL_DEFINITION: AdvertisedTool = {
  name: "definition_overrides",
  action: "ui_meta",
  description: "Inspect definition overrides and prepare exact keep-mine, adopt-default, or verified rebase results. A preparation is not approval. After preparation, get the person's confirmation for the preparation_id, then repeat with confirmation_id.",
  promptSnippet: "Review and resolve user definition overrides",
  inputSchema: INPUT_SCHEMA,
  isConcurrencySafe: false,
  deferUntilAssistantCommitted: true,
}

export function createDefinitionOverridesTool(options: DefinitionOverridesToolDeps | DefinitionOverrideOperations): RuntimeTool {
  const deps = "service" in options ? options : { service: options }
  const service = deps.service
  const needsThePerson = resolutionNeedsThePerson(deps.parentChannel === true)
  return {
    ...DEFINITION_OVERRIDES_TOOL_DEFINITION,
    async execute(input, context) {
      if (input.action === "list") return { content: JSON.stringify(await service.list(), null, 2), outcome: "ok" }
      const path = typeof input.path === "string" ? input.path : ""
      if (!path) return { content: "path is required for this action.", outcome: "error" }
      if (input.action === "diff") return { content: JSON.stringify(await service.diff(path), null, 2), outcome: "ok" }
      if (input.action !== "keep-mine" && input.action !== "adopt-default" && input.action !== "rebase") return { content: "action is invalid.", outcome: "error" }
      const action: OverrideResolutionAction = input.action
      if (deps.askUserAvailable !== true) return { content: needsThePerson, outcome: "error" }
      if (deps.packages?.review) return { content: "Learning Review cannot resolve definition overrides or acquire their user approval authority.", outcome: "error" }
      const proposed = action === "rebase" ? proposedContent(input) : undefined
      const prepared = await service.prepare(path, action, proposed)
      // A skill package publishes through the managed package writer. Its
      // refusal is known before the person is asked, so an approval is never
      // spent on a change that cannot apply.
      const publication = prepared.target.kind === "skill-package" ? skillPublication(prepared, prepared.target.reach, deps.packages, context.projectRoot) : undefined
      if (publication?.kind === "refused") return { content: publication.error, outcome: "error" }
      const confirmationId = typeof input.confirmation_id === "string" ? input.confirmation_id : ""
      if (!confirmationId) return { content: `${JSON.stringify(prepared)}\n\nAsk with ask_user decision { definition_override: { preparation_id: "${prepared.preparationId}" } } plus a context paragraph for the user, then repeat this call with confirmation_id.`, outcome: "error" }
      const writer = context.sessionEventWriter
      const consent = deps.packages?.consent
      if (!consent || !writer) return { content: "This session cannot claim definition override approval durably.", outcome: "error" }
      const toolUseId = context.toolUseId
      if (publication?.reach === "global" && !toolUseId) return { content: "Global skill publication requires a tool call id.", outcome: "error" }
      const claim = await claimAnsweredDecision({
        store: consent.store,
        writer,
        sessionId: consent.sessionId,
        interactionId: confirmationId,
        claimId: prepared.preparationId,
        consumption: "exactly-once",
        verify: (decision) => decision.kind === "definition_override" && decision.preparationId === prepared.preparationId ? undefined : "The confirmation approves a different definition override result.",
      })
      if (claim.kind === "refused") return { content: `Definition override approval refused: ${claim.reason.kind}.`, outcome: "error" }
      if (publication) {
        const { packages, mutation } = publication
        const result = publication.reach === "global" && toolUseId
          ? await packages.applyGlobal({ projectRoot: context.projectRoot, mutation, toolUseId, writer })
          : await packages.applyProject({ projectRoot: context.projectRoot, mutation, writer })
        if (result.kind === "refused") return { content: result.error, outcome: "error" }
        await service.finalizeSkillPublication(prepared)
        if (result.auditPending) return { content: `${action} applied to ${path}. Reach: ${publication.reach}. Its skill.written audit record is pending recovery. Do not repeat the publication.`, outcome: "error" }
        return { content: `${action} applied to ${path}.`, outcome: "ok" }
      }
      await service.apply(prepared)
      return { content: `${action} applied to ${path}.`, outcome: "ok" }
    },
  }
}

type SkillPublication =
  | { readonly kind: "ready"; readonly packages: ManagedPackageWrites; readonly mutation: ManagedPackageMutation; readonly reach: ManagedPackageReach }
  | { readonly kind: "refused"; readonly error: string }

function skillPublication(prepared: PreparedOverrideResolution, reach: ManagedPackageReach, packages: ManagedPackageWrites | undefined, projectRoot: string): SkillPublication {
  if (!packages) return { kind: "refused", error: "This session has no project skill publication authority." }
  const mutation = skillMutation(prepared)
  if (!mutation) return { kind: "refused", error: "The prepared project skill result is incomplete." }
  const refusal = packages.check({ projectRoot, mutation, reach })
  return refusal ? { kind: "refused", error: refusal } : { kind: "ready", packages, mutation, reach }
}

function skillMutation(prepared: PreparedOverrideResolution): ManagedPackageMutation | undefined {
  return prepared.action === "adopt-default"
    ? { kind: "remove_package" as const, name: prepared.target.id }
    : prepared.proposed?.kind === "skill-package"
      ? { kind: "replace_package" as const, name: prepared.target.id, files: prepared.proposed.files }
      : undefined
}

function proposedContent(input: DefinitionOverrideInput): CompleteOverrideContent | undefined {
  if (typeof input.merged_content === "string") return { kind: "single-file", content: input.merged_content }
  if (typeof input.merged_files !== "object" || input.merged_files === null || Array.isArray(input.merged_files)) return undefined
  const entries = Object.entries(input.merged_files)
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) throw new Error("Every merged_files value must be a string")
  if (!entries.some(([path]) => path === "SKILL.md")) throw new Error("A complete skill package must include SKILL.md")
  for (const [path] of entries) {
    const refusal = packagePathRefusal(path)
    if (refusal) throw new Error(refusal)
  }
  return { kind: "skill-package", files: Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))) }
}
