import type { AgentDurableFacts, AgentOptions } from "../../../../src/orchestration/agent-runtime/types"
import { testDirectories } from "../../../helpers/directories.js"

/** The fields of run options that a test overrides. `Partial` would make each half of the durable-facts pair optional
 *  on its own, so the pair stays whole. */
export type AgentOptionsOverride<O extends AgentOptions = AgentOptions> = Partial<Omit<O, keyof AgentDurableFacts>> & AgentDurableFacts

/** The options of a one-shot, stateless interactive chat runner, which a test overrides where it differs. */
export function makeOptions(overrides?: AgentOptionsOverride): AgentOptions {
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
