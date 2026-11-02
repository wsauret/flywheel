import { apiKey } from "../../infra/auth/auth-context.js";
import { EXA_WEB_PROVIDER_DEFINITION } from "../../infra/auth/web-providers.js";
import { createExaWebSearch } from "../agent-runtime/web-search/exa.js";
import type { FirstPartyModule, WebBackendContribution } from "../modules.js";

const backend = {
  id: "exa",
  create: ({ getAuth, connection }) => createExaWebSearch(() => apiKey(connection ? connection.auth : getAuth(), EXA_WEB_PROVIDER_DEFINITION.id)),
} as const satisfies WebBackendContribution;

export const webExaModule = {
  id: "web-exa",
  dependencies: ["web"],
  availability: { kind: "available" },
  contributions: [
    { domain: "webBackends", id: "exa", value: backend },
    { domain: "webAuthProviders", id: "exa", value: { ...EXA_WEB_PROVIDER_DEFINITION, group: "web" } },
    { domain: "settings", id: "web-exa", value: { control: "binary", group: "Web retrieval", label: "Exa web search", description: "Use Exa as a web retrieval backend" } },
  ],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule;
