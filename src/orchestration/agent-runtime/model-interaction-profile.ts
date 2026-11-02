import { isApplyPatchModel, type ModelFamily } from "../../infra/llm/model-family.js"
import { claude5ChatVariant, type Claude5ChatVariant } from "./claude-5-chat-prompt.js"

export const MODEL_INTERACTION_PROFILE_IDS = Object.freeze(["default"] as const)
export type ModelInteractionProfileId = (typeof MODEL_INTERACTION_PROFILE_IDS)[number]
type FileEditContractId = "edit" | "apply_patch"
export type ToolInteractionContract = `file-edit:${FileEditContractId}`

export interface ModelInteractionProfile {
  readonly id: ModelInteractionProfileId
  readonly fileEditContract: FileEditContractId
  /** The model-tuned interactive chat body that replaces the general chat prompt blocks, when the model has one.
   *  It changes no tool contract, so a profile that carries it keeps its tool-contract id. */
  readonly chatPrompt?: Claude5ChatVariant
}

export const DEFAULT_MODEL_INTERACTION_PROFILE: ModelInteractionProfile = Object.freeze({ id: "default", fileEditContract: "edit" })
const DEFAULT_PATCH_PROFILE: ModelInteractionProfile = Object.freeze({ id: "default", fileEditContract: "apply_patch" })

const claude5ChatProfile = (chatPrompt: Claude5ChatVariant): ModelInteractionProfile => Object.freeze({ ...DEFAULT_MODEL_INTERACTION_PROFILE, chatPrompt })
const CLAUDE_5_CHAT_PROFILES = Object.freeze({
  "opus-5.5": claude5ChatProfile("opus-5.5"),
  "sonnet-5.5": claude5ChatProfile("sonnet-5.5"),
  "fable-5.1": claude5ChatProfile("fable-5.1"),
} satisfies { readonly [variant in Claude5ChatVariant]: ModelInteractionProfile })

export function resolveModelInteractionProfile(model: string, modelFamily: ModelFamily): ModelInteractionProfile {
  // The chat body follows the canonical model, not its transport: OpenRouter serves Claude over an OpenAI-compatible family.
  const chatVariant = claude5ChatVariant(model)
  if (chatVariant) return CLAUDE_5_CHAT_PROFILES[chatVariant]
  return modelFamily === "openai" && isApplyPatchModel(model) ? DEFAULT_PATCH_PROFILE : DEFAULT_MODEL_INTERACTION_PROFILE
}
