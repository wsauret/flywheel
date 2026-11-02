import type { AgentOptions } from "../../../../src/orchestration/agent-runtime/types"
import { testDirectories } from "../../../helpers/directories.js"

/** The options of a one-shot, stateless interactive chat runner, which a test overrides where it differs. */
export function makeOptions(overrides?: Partial<AgentOptions>): AgentOptions {
  return {
    model: "claude-haiku-4-5-20251001",
    purpose: { kind: "interactive-chat" },
    ...testDirectories("/scratch"),
    onEvent: () => {},
    runtimeSurfaces: {},
    conversation: { kind: "stateless" },
    lifecycle: { kind: "one-shot" },
    ...overrides,
  }
}
