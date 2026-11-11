import { isApplyPatchModel, type ModelFamily } from "../../infra/llm/model-family.js"
import { familySettings } from "./llm/model-compat.js"
import { MODEL_CHAT_GUIDANCE, type ModelChatGuidance } from "./model-chat-body.js"

export const MODEL_INTERACTION_PROFILE_IDS = Object.freeze(["default"] as const)
export type ModelInteractionProfileId = (typeof MODEL_INTERACTION_PROFILE_IDS)[number]
type FileEditContractId = "edit" | "apply_patch"
export type ToolInteractionContract = `file-edit:${FileEditContractId}`

export interface ModelInteractionProfile {
  readonly id: ModelInteractionProfileId
  readonly fileEditContract: FileEditContractId
  /** The guidance blocks of the model's interactive chat body, which replaces the general chat prompt blocks, when
   *  the model has a guidance entry. It changes no tool contract, so a profile that carries it keeps its
   *  tool-contract id. */
  readonly chatGuidance?: ModelChatGuidance
}

export const DEFAULT_MODEL_INTERACTION_PROFILE: ModelInteractionProfile = Object.freeze({ id: "default", fileEditContract: "edit" })
const DEFAULT_PATCH_PROFILE: ModelInteractionProfile = Object.freeze({ id: "default", fileEditContract: "apply_patch" })

/** One frozen profile per guidance entry, so every model that resolves to an entry shares its profile object. */
const chatProfile = familySettings<ModelInteractionProfile>(
  MODEL_CHAT_GUIDANCE.map(([model, chatGuidance]) => [model, Object.freeze({ ...DEFAULT_MODEL_INTERACTION_PROFILE, chatGuidance })]),
)

export function resolveModelInteractionProfile(model: string, modelFamily: ModelFamily): ModelInteractionProfile {
  // The chat body follows the canonical model, not its transport: OpenRouter serves Claude over an OpenAI-compatible family.
  const chat = chatProfile(model)
  if (chat) return chat.value
  return modelFamily === "openai" && isApplyPatchModel(model) ? DEFAULT_PATCH_PROFILE : DEFAULT_MODEL_INTERACTION_PROFILE
}
