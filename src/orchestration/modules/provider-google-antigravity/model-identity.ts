import { QUALIFIED_ANTIGRAVITY_VERSION } from "../../../infra/antigravity-engine-pin.js"
import { canonicalModelId } from "../../../infra/model-id.js"
import type { CatalogWireIdentity } from "../../../infra/llm/model-catalog-resolution.js"

/**
 * The Flywheel model that an engine family serves, by the agy version it was observed on, where the family's name
 * differs from the model that agy requests from Google: the fake Gemini host saw `gemini-3.1-pro` request
 * `gemini-3.1-pro-preview`, and `gemini-3.8-flash` and `gemini-4-neon` request themselves. Every other family keeps
 * its own name under Flywheel's shared model identity.
 */
const SERVED_MODEL = new Map<string, ReadonlyMap<string, string>>([
  ["1.5.14", new Map([["gemini-3.1-pro", "gemini-3.1-pro-preview"]])],
])

/** The Flywheel identity of the wire `wireModelId`: an agy model family, or a models.dev `google` wire whose metadata
 *  describes one, so both join on the model that the Google API Key provider names the same way. */
export function antigravityWireIdentity(wireModelId: string): CatalogWireIdentity {
  return { modelId: SERVED_MODEL.get(QUALIFIED_ANTIGRAVITY_VERSION)?.get(wireModelId) ?? canonicalModelId(wireModelId) }
}
