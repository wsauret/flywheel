import type { CatalogDataUse } from "./model-id.js";
import type { ModelInfo } from "./llm/models/models.js";

/** One provider route of a catalog model: the record that catalog resolution builds and route metadata reads. */
export interface CatalogModelOffering {
  readonly wireModelId: string;
  readonly metadata: CatalogJsonValue;
  readonly dataUse: CatalogDataUse;
  readonly routeKind?: "free";
  readonly resolvedMetadata?: ModelInfo;
  readonly transport?: OfferingTransport;
}

export type CatalogJsonValue = string | number | boolean | null | readonly CatalogJsonValue[] | { readonly [key: string]: CatalogJsonValue };

export type OfferingTransport = "anthropic-messages" | "openai-responses" | "chat-completions" | "google";
