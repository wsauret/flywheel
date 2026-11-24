import { QUALIFIED_ANTIGRAVITY_VERSION } from "../../../infra/antigravity-engine-pin.js"

/** The context window of one engine model family on this route (plan P9). agy summarizes a session by itself when
 *  the tokens that the previous model response reported reach a fixed threshold of the current model, and no setting
 *  turns that off or raises it. Flywheel compacts its own history first, so the route offers a window below the
 *  threshold, and the bridge keeps each session's occupancy below `threshold`. */
export interface AntigravityContextLimits {
  /** The largest occupancy, in tokens, at which agy was measured not to summarize the session. */
  readonly threshold: number
  /** The window the route offers: both `contextLimit` and `totalContextLimit` of the family's catalog row. */
  readonly contextLimit: number
}

const BELOW_256K: AntigravityContextLimits = { threshold: 250_000, contextLimit: 230_000 }

/**
 * The qualified limits of each engine model family, by the agy version they were measured on. Measured against the
 * fake Gemini host with usage that the host reported: 3.1 Pro, 3.8 Flash and 4 Hydrogen did not summarize at 250,000
 * tokens and did at 260,000 (3.1 Pro Low at 255,999); 4 Neon not at 511,000 and at 512,000; 4 Carbon and 4 Argon not
 * at 500,000 and at 520,000. A family with no entry, such as 3.7 Flash and 3.6 Flash, which were not measured, has no
 * qualified window and is not offered. A new pinned version has no entry until its families are measured again, so
 * it offers no family. The table names Gemini families only: the route never offers a model of another vendor that
 * agy lists, such as Claude or GPT-OSS (a non-goal of the provider).
 */
const QUALIFIED_LIMITS = new Map<string, ReadonlyMap<string, AntigravityContextLimits>>([
  ["1.5.14", new Map([
    ["gemini-3.1-pro", BELOW_256K],
    ["gemini-3.8-flash", BELOW_256K],
    ["gemini-4-hydrogen", BELOW_256K],
    ["gemini-4-neon", { threshold: 511_000, contextLimit: 460_000 }],
    ["gemini-4-carbon", { threshold: 500_000, contextLimit: 460_000 }],
    ["gemini-4-argon", { threshold: 500_000, contextLimit: 460_000 }],
  ])],
])

/** The qualified limits of the engine model family `family` (an agy `model` option value, such as `gemini-3.1-pro`)
 *  on the pinned agy, or nothing when the family has none and is not offered. */
export function antigravityContextLimits(family: string): AntigravityContextLimits | undefined {
  return QUALIFIED_LIMITS.get(QUALIFIED_ANTIGRAVITY_VERSION)?.get(family)
}
