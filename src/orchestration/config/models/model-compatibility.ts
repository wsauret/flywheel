import { canonicalModelId } from "../../../infra/providers/model-id.js";
const CONTEXT_SUFFIX_RE = /\[\w+\]$/;

export function normalizeSelectableModelId(model: string): string {
  return canonicalModelId(model).replace(CONTEXT_SUFFIX_RE, "");
}

