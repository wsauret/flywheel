import { isApplyPatchModel, type ModelFamily } from "../../infra/llm/model-family.js"
import { familySettings } from "./llm/model-compat.js"
import { MODEL_GUIDANCE, type ModelGuidance } from "./model-chat-body.js"

export const MODEL_INTERACTION_PROFILE_IDS = Object.freeze(["default"] as const)
export type ModelInteractionProfileId = (typeof MODEL_INTERACTION_PROFILE_IDS)[number]
type FileEditContractId = "edit" | "apply_patch"
export type ToolInteractionContract = `file-edit:${FileEditContractId}`

export interface ModelInteractionProfile {
  readonly id: ModelInteractionProfileId
  readonly fileEditContract: FileEditContractId
  /** The model's guidance blocks, when the model has a guidance entry: the chat blocks that its chat body adds to the
   *  base, and the agent blocks of its subagents and workflow agents. It changes
   *  no tool contract, so a profile that carries it keeps its tool-contract id. */
  readonly modelGuidance?: ModelGuidance
}

type ProfilesByContract = { readonly [contract in FileEditContractId]: ModelInteractionProfile }

const profiles = (modelGuidance?: ModelGuidance): ProfilesByContract => ({
  edit: Object.freeze({ id: "default", fileEditContract: "edit", ...(modelGuidance ? { modelGuidance } : {}) }),
  apply_patch: Object.freeze({ id: "default", fileEditContract: "apply_patch", ...(modelGuidance ? { modelGuidance } : {}) }),
})

const DEFAULT_PROFILES = profiles()
export const DEFAULT_MODEL_INTERACTION_PROFILE: ModelInteractionProfile = DEFAULT_PROFILES.edit

/** One frozen profile per guidance entry and edit contract, so every model that resolves to the same pair shares
 *  one profile object. */
const guidedProfiles = familySettings(MODEL_GUIDANCE.map(([model, modelGuidance]) => [model, profiles(modelGuidance)] as const))

export function resolveModelInteractionProfile(model: string, modelFamily: ModelFamily): ModelInteractionProfile {
  // A guidance entry keeps the edit contract that the model's family and id select. The guidance follows the
  // canonical model, not its transport: OpenRouter serves Claude over an OpenAI-compatible family.
  const contract = modelFamily === "openai" && isApplyPatchModel(model) ? "apply_patch" : "edit"
  return (guidedProfiles(model)?.value ?? DEFAULT_PROFILES)[contract]
}
