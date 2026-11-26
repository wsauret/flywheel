import { buildCustomProviderSlice, publishCustomProviderSlice, type CustomProviderDefinition, type CustomProviderRejection } from "../../src/infra/providers/llm/custom-provider-registry.js";

/** Publishes `definitions` as the installed custom provider slice, the way a config load does. */
export function installCustomProviders(definitions: readonly CustomProviderDefinition[], rejections: readonly CustomProviderRejection[] = []): void {
  publishCustomProviderSlice(buildCustomProviderSlice(definitions, rejections));
}
