import { createChatGptWebSearch } from "../agent-runtime/web-search/chatgpt.js";
import type { FirstPartyModule, WebBackendContribution } from "../modules.js";

const backend = {
  id: "chatgpt",
  create: ({ authDir, connection, credentialSlotClassifier }) => createChatGptWebSearch(authDir, credentialSlotClassifier, undefined, connection),
} as const satisfies WebBackendContribution;

export const webChatgptModule = {
  id: "web-chatgpt",
  dependencies: ["web"],
  availability: { kind: "available" },
  contributions: [
    { domain: "webBackends", id: "chatgpt", value: backend },
    { domain: "settings", id: "web-chatgpt", value: { control: "binary", group: "Web retrieval", label: "ChatGPT web search", description: "Use ChatGPT as a web retrieval backend" } },
  ],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule;
