import { describe, expect, it } from "bun:test";
import {
  opencodeGoEndpointForMetadata,
} from "../../../../src/infra/llm/opencode-go-model-support.js";

describe("OpenCode Go model support", () => {
  it("defaults to chat completions and lets models.dev npm metadata override it", () => {
    expect(opencodeGoEndpointForMetadata(null)).toBe("openai-completions");
    expect(opencodeGoEndpointForMetadata({ transport: { npm: "@ai-sdk/anthropic" } })).toBe("anthropic-messages");
    expect(opencodeGoEndpointForMetadata({ transport: { npm: "@ai-sdk/openai" } })).toBe("openai-responses");
    expect(opencodeGoEndpointForMetadata({ transport: { npm: "@ai-sdk/openai-compatible" } })).toBe("openai-completions");
  });
});
