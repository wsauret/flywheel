import bundledModelsJson from "../src/infra/llm/models-bundled.txt";
import { canonicalCatalogModelId, canonicalModelId } from "../src/infra/llm/model-id.js";
import { admitModelsDocument, type AdmittedModelsDocument } from "../src/infra/llm/models-document.js";
import { modelMapIndex, providerNamespaceIndex, resolveLegacyRelationship, resolveModelMapRelationship } from "../src/infra/llm/model-relationships.js";

export type ModelCatalogIssue =
  | { readonly kind: "invalid-exact-relationship"; readonly providerId: string; readonly wireModelId: string; readonly canonicalModelId: string }
  | { readonly kind: "unclassified-terminal-contributor"; readonly providerId: string; readonly wireModelId: string }
  | { readonly kind: "duplicate-display-label"; readonly providerId: string; readonly displayLabel: string; readonly canonicalModelIds: readonly string[] };

const CONTRIBUTOR_MARKER = /-contributor(?:-[\w.-]+)?$/;

function equivalentPreviewChoices(modelIds: readonly string[]): boolean {
  return new Set(modelIds.map((id) => id.replace(/-preview$/, ""))).size === 1;
}

/** Audits publication-sensitive identities in an admitted models.dev document. */
export function checkModelCatalog(admitted: AdmittedModelsDocument): readonly ModelCatalogIssue[] {
  const issues: ModelCatalogIssue[] = [];
  const { document } = admitted;
  const openRouter = document.openrouter;
  if (!openRouter) return issues;
  const openRouterId = openRouter.id ?? "openrouter";
  const currentRelationships = modelMapIndex(admitted.modelMap);
  const legacyNamespaces = providerNamespaceIndex(document);
  const legacyRelationships = new Map();

  const labels = new Map<string, Set<string>>();
  for (const model of Object.values(openRouter.models)) {
    const slash = model.id.indexOf("/");
    const sourceIdentity = canonicalCatalogModelId(model.id);
    const relationship = admitted.relationshipAuthority === "model-map"
      ? resolveModelMapRelationship(currentRelationships, openRouterId, model.id)
      : resolveLegacyRelationship(document, legacyNamespaces, legacyRelationships, openRouterId, model.id, sourceIdentity.modelId);
    const identity = relationship === null ? sourceIdentity : { ...sourceIdentity, modelId: relationship.modelId };
    if (CONTRIBUTOR_MARKER.test(model.id) && sourceIdentity.dataUse !== "contributor") {
      issues.push({ kind: "unclassified-terminal-contributor", providerId: "openrouter", wireModelId: model.id });
    }

    if (model.name) {
      const choices = labels.get(model.name) ?? new Set<string>();
      choices.add(identity.modelId);
      labels.set(model.name, choices);
    }

    if (relationship === null) continue;
    const wireCanonicalId = canonicalCatalogModelId(slash === -1 ? model.id : model.id.slice(slash + 1)).modelId;
    const relationshipCanonicalId = canonicalModelId(relationship.modelId);
    if (wireCanonicalId !== relationshipCanonicalId) {
      issues.push({
        kind: "invalid-exact-relationship",
        providerId: relationship.providerId,
        wireModelId: model.id,
        canonicalModelId: relationshipCanonicalId,
      });
    }
  }

  for (const [displayLabel, choices] of labels) {
    const canonicalModelIds = [...choices].toSorted();
    if (canonicalModelIds.length > 1 && !equivalentPreviewChoices(canonicalModelIds)) {
      issues.push({ kind: "duplicate-display-label", providerId: "openrouter", displayLabel, canonicalModelIds });
    }
  }
  return issues;
}

export function assertModelCatalog(document: AdmittedModelsDocument): void {
  const issues = checkModelCatalog(document);
  if (issues.length > 0) throw new Error(`Model catalog audit failed:\n${issues.map((issue) => JSON.stringify(issue)).join("\n")}`);
}

if (import.meta.main) {
  assertModelCatalog(admitModelsDocument(bundledModelsJson));
  console.log("Model catalog audit passed");
}
