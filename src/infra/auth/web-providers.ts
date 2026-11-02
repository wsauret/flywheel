/**
 * Credentialed web retrieval providers: the id universe for web-search
 * credentials stored in the unified auth store. Separate from the model
 * access providers so web credentials never enter model-family selection.
 * The definitions tuple is the single source of the union and of every
 * enumeration: adding a provider here extends the auth store keys, the
 * /auth surface, the status report, and the runtime protocol type.
 */

import type { CredentialProviderCli } from "../llm/access-provider.js";

export interface WebProviderDefinition {
  readonly id: WebProviderId;
  readonly displayName: string;
  readonly cli: CredentialProviderCli;
}

export type WebProviderId = "exa";

export const EXA_WEB_PROVIDER_DEFINITION = { id: "exa", displayName: "Exa API Key", cli: { flag: "exa", name: "Exa web search" } } as const satisfies WebProviderDefinition;
const WEB_PROVIDER_DEFINITIONS = [EXA_WEB_PROVIDER_DEFINITION] as const;

const WEB_PROVIDER_IDS: readonly WebProviderId[] = WEB_PROVIDER_DEFINITIONS.map((definition) => definition.id);


export function isWebProviderId(id: string): id is WebProviderId {
  return WEB_PROVIDER_IDS.some((webId) => webId === id);
}
