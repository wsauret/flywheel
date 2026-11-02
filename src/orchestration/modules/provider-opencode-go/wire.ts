/** The site that serves the OpenCode Go account pages and API. */
const SITE = "https://opencode.ai";
/** Where a person manages the subscription. */
export const OPENCODE_GO_BILLING_URL = `${SITE}/auth`;
/** The root of the subscription's Anthropic Messages wire. */
export const OPENCODE_GO_API_BASE = `${SITE}/zen/go`;
/** The root of the subscription's OpenAI wires, its model list, and its usage report. */
export const OPENCODE_GO_V1_BASE = `${OPENCODE_GO_API_BASE}/v1`;
/** The models.dev provider whose entries carry the metadata of the models that the subscription serves. */
export const OPENCODE_GO_METADATA_PROVIDER = "opencode";
