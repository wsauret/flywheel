import { REASONING_EFFORTS, type ModelInfo, type ProviderReasoningEffort, type ReasoningEffort } from "../../../infra/llm/models.js";
import { canonicalModelId } from "../../../infra/llm/model-id.js";

/**
 * Per-model compat flags for wire-protocol quirks that models.dev's `ModelInfo`
 * doesn't carry: Anthropic adaptive-thinking shape, Copilot proxy support for
 * fine-grained tool streaming, OpenAI o-series rejection of parallel_tool_calls,
 * Gemini 3 thinking-level vs 2.5 thinking-budget, etc.
 *
 * Lookup table first, model metadata second, regex heuristic fallback for models
 * without a row. The table is keyed by canonical model id (`canonicalModelId`), and
 * every lookup canonicalizes its input, so dashed, dotted, and date-stamped spellings
 * of one model read the same row. Keep this file as the single source of truth for
 * these checks across all 5 providers.
 *
 * Reasoning-effort tier support is data-driven instead: models.dev's
 * `reasoning_options` (ModelInfo.reasoningEfforts) declares each model's tiers,
 * and clampReasoningEffort resolves undeclared tiers to the nearest declared one.
 *
 * Inspired by pi's `MODELS.generated.ts` per-model declarations.
 */

const FIRST_ADAPTIVE_ANTHROPIC_RELEASE_DATE = "2026-02-01";

/** `thinkingOff` and `perTurnEffort` resolve by model family (`familySettings`): a version without its own entry
 *  takes the entry of the newest earlier version of its family. Every other field applies to its exact model only. */
interface ModelCompat {
  /** Adaptive-thinking wire shape. Explicit false entries preserve legacy
   *  budget-token models; new Claude-family Anthropic models default adaptive. */
  adaptiveThinking?: boolean;
  /** Off requests use disabled thinking unless the model needs an adaptive
   *  shape or omission. Anthropic rejects disabled thinking for both cases. */
  thinkingOff?: "adaptive" | "omit";
  /** Copilot proxy doesn't support `eager_input_streaming` (the
   *  fine-grained-tool-streaming beta) for claude-haiku-4.5 and claude-sonnet-4.5. */
  eagerToolStreamingOnCopilot?: boolean;
  /** OpenAI o-series reject `parallel_tool_calls: true` with a 400. gpt-5 + 4o accept it. */
  parallelToolCalls?: boolean;
  /** Gemini 3 + Gemma 4 use `thinkingConfig: {thinkingLevel: ENUM}`;
   *  Gemini 2.5 uses `thinkingConfig: {thinkingBudget: N}`. */
  geminiThinkingConfigMode?: "level" | "budget";
  /** Whether the model reads the thinking of an earlier turn that a request
   *  replays. Every model reads the thinking of the current turn's tool
   *  loop; a model that drops earlier thinking does not charge for it. */
  keepsEarlierTurnReasoning?: boolean;
  /** Whether the Claude engine sends the model's effort inside the conversation too: the `per_turn_effort` capability of
   *  its model catalog (CLI 2.1.296). */
  perTurnEffort?: boolean;
  /** The most images one provider request may carry, counted over all
   *  messages, tool results included. Absent means no limit. */
  maxImagesPerRequest?: number;
}

interface ModelCompatById { [model: string]: ModelCompat }

const MODEL_COMPAT: ModelCompatById = {
  // Anthropic: always-thinking models reject thinking:{type:"disabled"}
  "claude-fable-5": { thinkingOff: "omit" },
  // Anthropic: the models with the Claude engine's per_turn_effort capability (CLI 2.1.296)
  "claude-haiku-5.5": { perTurnEffort: true },
  "claude-sonnet-5.5": { perTurnEffort: true, thinkingOff: "adaptive" },
  "claude-opus-5.5": { perTurnEffort: true, thinkingOff: "adaptive" },
  "claude-fable-5.1": { perTurnEffort: true },
  "claude-fable-5.2": { perTurnEffort: true },
  // Anthropic: adaptive thinking
  "claude-opus-4.6": { adaptiveThinking: true, eagerToolStreamingOnCopilot: true },
  "claude-opus-4.7": { adaptiveThinking: true, eagerToolStreamingOnCopilot: true },
  "claude-sonnet-4.6": { adaptiveThinking: true, eagerToolStreamingOnCopilot: true },
  // Anthropic 4.5, pre-adaptive; suppress eager-tool-streaming on Copilot
  "claude-haiku-4.5": { adaptiveThinking: false, eagerToolStreamingOnCopilot: false },
  "claude-sonnet-4.5": { adaptiveThinking: false, eagerToolStreamingOnCopilot: false },
  // Claude Opus 4.5 is the first Claude model that keeps earlier-turn thinking.
  "claude-opus-4.5": { adaptiveThinking: false, eagerToolStreamingOnCopilot: true, keepsEarlierTurnReasoning: true },
  // Copilot's proxy also rejects eager streaming on plain sonnet-4 (pi
  // EAGER_TOOL_INPUT_STREAMING_UNSUPPORTED, `generate-models.ts:255-259`)
  "claude-sonnet-4": { adaptiveThinking: false, eagerToolStreamingOnCopilot: false },

  // OpenCode Go's Anthropic wire (qwen): the budget-token thinking shape
  // 400s on qwen3.8-max while the adaptive shape works across the family.
  "qwen3.5-plus": { adaptiveThinking: true },
  "qwen3.6-plus": { adaptiveThinking: true },
  "qwen3.7-plus": { adaptiveThinking: true },
  "qwen3.7-max": { adaptiveThinking: true },
  "qwen3.8-max": { adaptiveThinking: true },

  // OpenAI: o-series reject parallel_tool_calls
  "o1": { parallelToolCalls: false },
  "o1-preview": { parallelToolCalls: false },
  "o1-mini": { parallelToolCalls: false },
  "o3": { parallelToolCalls: false },
  "o3-mini": { parallelToolCalls: false },
  "o4-mini": { parallelToolCalls: false },

  // Google: thinking config shape. The `-latest` aliases track the current
  // Gemini 3 flash releases and take the level shape (pi
  // `providers/google.ts:420-423`).
  "gemini-3-pro": { geminiThinkingConfigMode: "level" },
  "gemini-3-flash": { geminiThinkingConfigMode: "level" },
  "gemini-3-flash-lite": { geminiThinkingConfigMode: "level" },
  "gemini-flash-latest": { geminiThinkingConfigMode: "level" },
  "gemini-flash-lite-latest": { geminiThinkingConfigMode: "level" },
  "gemma-4": { geminiThinkingConfigMode: "level" },
  "gemini-2.5-pro": { geminiThinkingConfigMode: "budget" },
  "gemini-2.5-flash": { geminiThinkingConfigMode: "budget" },
  "gemini-2.5-flash-lite": { geminiThinkingConfigMode: "budget" },

  // DeepSeek V4.1 Flash on OpenRouter (probe of 2026-11-08, pinned to
  // deepinfra/fp8): a request with 30 images returns 200, and one with 31 or
  // more returns 404 because the image-support routing filter removes the
  // DeepInfra endpoints. The count is per request, over all messages.
  "deepseek-v4.1-flash": { maxImagesPerRequest: 30 },
};

function lookup(model: string): ModelCompat | undefined {
  return MODEL_COMPAT[canonicalModelId(model)];
}

/** The spelling that the legacy-Claude heuristics read for a model without a row. */
function normalizeModelId(model: string): string {
  return model.toLowerCase().replace(/_/g, "-");
}

/** A canonical model id with its version last, or before one tier name: `claude-fable-5.2` is version 5.2 of the
 *  family `claude-fable`, and `gpt-6.1-sol` is version 6.1 of the family `gpt-sol`. */
const VERSIONED_MODEL = /^(.+?)-(\d+)(?:\.(\d+))?(?:-([a-z]+))?$/u;

/** The family, major, and minor version of `canonical`, or undefined for an id without a version. */
function modelVersion(canonical: string): { readonly family: string; readonly major: number; readonly minor: number } | undefined {
  const match = VERSIONED_MODEL.exec(canonical);
  if (match?.[1] === undefined) return undefined;
  return { family: match[4] === undefined ? match[1] : `${match[1]}-${match[4]}`, major: Number(match[2]), minor: Number(match[3] ?? 0) };
}

/** One per-model setting of `model`: the value of the model's own entry, or the value that it inherits from the entry
 *  of `inheritedFrom`, an earlier version of its family. */
export interface FamilySetting<T> {
  readonly value: T;
  readonly inheritedFrom?: string;
}

/**
 * The one lookup of a per-model setting by model family. A model takes its own entry first (any spelling of its id,
 * date snapshots included), else the entry of the newest earlier version of its family in the same major line
 * (`claude-fable-5.2` takes `claude-fable-5.1`, and `gpt-6.2-sol` takes `gpt-6.1-sol`), else nothing. It never
 * inherits from a later version, another major line, or another family, so a model that the provider turns on runs with its family's known settings from that day
 * until it gets its own entry.
 */
export function familySettings<T>(entries: Iterable<readonly [string, T]>): (model: string) => FamilySetting<T> | undefined {
  const own = new Map<string, T>();
  const versions: { readonly model: string; readonly family: string; readonly major: number; readonly minor: number; readonly value: T }[] = [];
  for (const [model, value] of entries) {
    const canonical = canonicalModelId(model);
    own.set(canonical, value);
    const version = modelVersion(canonical);
    if (version !== undefined) versions.push({ model: canonical, ...version, value });
  }
  return (model) => {
    const canonical = canonicalModelId(model);
    const value = own.get(canonical);
    if (value !== undefined) return { value };
    const version = modelVersion(canonical);
    if (version === undefined) return undefined;
    const earlier = versions
      .filter((entry) => entry.family === version.family && entry.major === version.major && entry.minor < version.minor)
      .reduce<(typeof versions)[number] | undefined>((newest, entry) => (newest === undefined || entry.minor > newest.minor ? entry : newest), undefined);
    return earlier === undefined ? undefined : { value: earlier.value, inheritedFrom: earlier.model };
  };
}

/** The family lookup of one `ModelCompat` field over the entries that state it. */
function compatSetting<K extends keyof ModelCompat>(field: K): (model: string) => FamilySetting<NonNullable<ModelCompat[K]>> | undefined {
  return familySettings(Object.entries(MODEL_COMPAT).flatMap(([model, entry]) => {
    const value = entry[field];
    return value === undefined ? [] : [[model, value] as const];
  }));
}

const perTurnEffort = compatSetting("perTurnEffort");
const thinkingOff = compatSetting("thinkingOff");

/** Anthropic models that take the `{type: "adaptive"}` thinking shape. */
export function supportsAdaptiveThinking(model: string, info: ModelInfo): boolean {
  const entry = lookup(model);
  if (entry?.adaptiveThinking !== undefined) return entry.adaptiveThinking;
  const normalizedModel = normalizeModelId(model);
  if (!normalizedModel.includes("claude-")) return false; // provider-model-literal-allow: payload -- Anthropic adaptive-thinking wire shape compatibility
  const releaseDate = isoDate(info.releaseDate);
  if (releaseDate) return releaseDate >= FIRST_ADAPTIVE_ANTHROPIC_RELEASE_DATE;
  const legacyMajor = /claude-[1-3](?:[-.]|$)/.test(normalizedModel);
  const legacyFamilyFirst = /claude-(?:opus|sonnet|haiku)[-.]4(?:[-.](?:[0-5](?:[-.]|$)|\d{6,}(?:[-.]|$))|$)/.test(normalizedModel);
  return !(legacyMajor || legacyFamilyFirst);
}

function isoDate(value: string | undefined): string | null {
  return value?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
}

/** Models that read the thinking of an earlier turn when a request replays
 *  it. Claude models from Claude Opus 4.5 on keep it; count_tokens shows
 *  Claude Haiku 4.5 dropping it and Claude Sonnet 5.5 keeping it. Every other
 *  model counts as dropping it: OpenAI documents that it drops reasoning items
 *  from earlier turns. */
export function keepsEarlierTurnReasoning(model: string): boolean {
  const entry = lookup(model);
  if (entry?.keepsEarlierTurnReasoning !== undefined) return entry.keepsEarlierTurnReasoning;
  const normalizedModel = normalizeModelId(model);
  if (!normalizedModel.includes("claude-")) return false; // provider-model-literal-allow: payload -- Anthropic earlier-turn thinking retention
  const legacyMajor = /claude-[1-3](?:[-.]|$)/.test(normalizedModel);
  const legacyFamilyFirst = /claude-(?:opus|sonnet|haiku)[-.]4(?:[-.](?:[0-5](?:[-.]|$)|\d{6,}(?:[-.]|$))|$)/.test(normalizedModel);
  return !(legacyMajor || legacyFamilyFirst);
}

/** Anthropic models whose effort the Claude engine also sends inside the conversation (`withPerTurnEffort`). */
export function supportsPerTurnEffort(model: string): boolean {
  return perTurnEffort(model)?.value === true;
}

/** Whether `model` has per-turn effort only through an earlier version of its family. Flywheel then has no entry of
 *  its own for the model, which stands for a model that the bundled Claude engine does not know yet either. */
export function inheritsPerTurnEffort(model: string): boolean {
  const setting = perTurnEffort(model);
  return setting?.value === true && setting.inheritedFrom !== undefined;
}

/** The most images one request for `model` may carry (`ModelCompat.maxImagesPerRequest`), or undefined when the
 *  model has no limit. */
export function maxImagesPerRequest(model: string): number | undefined {
  return lookup(model)?.maxImagesPerRequest;
}

/** The accepted Anthropic thinking shape for an off request. Omit means the
 *  caller leaves thinking unspecified. Accepts canonical and wire model ids. */
function thinkingOffMode(model: string): "disabled" | "adaptive" | "omit" {
  return thinkingOff(model)?.value ?? "disabled";
}

/** Select the thinking shape from the model's reasoning support and requested effort.
 *  Omit leaves thinking unspecified for non-reasoning models and always-thinking
 *  models that reject disabled thinking (pi `anthropic-messages.ts:1028,1053-1055`). */
export function anthropicThinkingMode(
  model: string,
  info: ModelInfo,
  effort: ReasoningEffort,
  reasoningSupported: boolean,
): "adaptive" | "enabled" | "disabled" | "omit" {
  if (!reasoningSupported) return "omit";
  const offMode = thinkingOffMode(model);
  if (effort === "off" && offMode !== "adaptive") return offMode;
  return supportsAdaptiveThinking(model, info) ? "adaptive" : "enabled";
}

/** Whether a chat-completions proxy can request reasoning off. An Anthropic
 *  adaptive wire requirement does not change the proxy's reasoning field. */
export function supportsThinkingDisable(model: string): boolean {
  return thinkingOffMode(model) !== "omit";
}

/** Copilot-proxy support for the `fine-grained-tool-streaming-2025-05-14` beta
 *  and the `eager_input_streaming: true` field on tool definitions. */
export function supportsEagerToolStreamingOnCopilot(model: string): boolean {
  return lookup(model)?.eagerToolStreamingOnCopilot ?? true;
}

/** OpenAI models that accept `parallel_tool_calls: true`. o-series reject it. */
export function supportsParallelToolCalls(model: string): boolean {
  const entry = lookup(model);
  if (entry?.parallelToolCalls !== undefined) return entry.parallelToolCalls;
  // Fallback: o-series by name.
  return !/^o\d/.test(model);
}

/** Gemini thinking config shape: `level` enum or `budget` numeric. */
export function geminiThinkingConfigMode(model: string): "level" | "budget" {
  const entry = lookup(model);
  if (entry?.geminiThinkingConfigMode !== undefined) return entry.geminiThinkingConfigMode;
  // Fallback: Gemini 3 + Gemma 4 use levels; older variants use budgets.
  if (/gemini-3/i.test(model)) return "level";
  if (/gemma-?4/i.test(model)) return "level";
  return "budget";
}

/** OpenAI Responses models that accept `reasoning: {effort: "none"}`. */
export function supportsReasoningOff(info: ModelInfo): boolean {
  return info.reasoningEfforts?.includes("none") ?? false;
}

export type ReasoningEffortTier = Exclude<ReasoningEffort, "off">;

/** The author's selectable efforts, matching the model picker's metadata policy. */
export function effortOptionsForMetadata(info: Pick<ModelInfo, "reasoningEfforts"> | undefined): readonly ReasoningEffortTier[] {
  const supported = info?.reasoningEfforts;
  // Models without an effort declaration use the same safe tiers as role resolution.
  if (!supported) return ["low", "medium", "high"];
  return EFFORT_ORDER.filter((effort) => supported.includes(effort));
}

const EFFORT_ORDER: readonly ReasoningEffortTier[] = REASONING_EFFORTS.filter((tier): tier is ReasoningEffortTier => tier !== "off");

const PROVIDER_EFFORT_ORDER: readonly Exclude<ProviderReasoningEffort, "none">[] = ["minimal", ...EFFORT_ORDER];

/** Clamp a requested effort to the tiers a model declares via models.dev
 *  `reasoning_options` (ModelInfo.reasoningEfforts); `fallback` (non-empty) is
 *  the assumed support set for models with no declaration. An undeclared tier
 *  resolves to the nearest declared one, with ties rounding up: Opus 4.6
 *  declares max but not xhigh, and a requested xhigh must upgrade to max there
 *  (pi's `thinkingLevelMap` declares `{"xhigh":"max"}`). */
export function clampReasoningEffort(
  effort: ReasoningEffortTier,
  info: Pick<ModelInfo, "reasoningEfforts"> | null,
  fallback: readonly [ReasoningEffortTier, ...ReasoningEffortTier[]],
): ReasoningEffortTier {
  const declared = info?.reasoningEfforts?.filter((tier): tier is ReasoningEffortTier => tier !== "none" && tier !== "minimal");
  const supported = declared?.length ? declared : fallback;
  if (supported.includes(effort)) return effort;
  const requested = EFFORT_ORDER.indexOf(effort);
  const distance = (tier: ReasoningEffortTier) => {
    const index = EFFORT_ORDER.indexOf(tier);
    return Math.abs(index - requested) * 2 - (index > requested ? 1 : 0);
  };
  return supported.reduce((best, tier) => (distance(tier) < distance(best) ? tier : best));
}

/** Select the closest provider-declared Responses wire tier. A tie selects the
 * lower tier, so a low request uses minimal instead of increasing effort. */
export function openAIReasoningEffort(effort: ReasoningEffortTier, info: ModelInfo): Exclude<ProviderReasoningEffort, "none"> | undefined {
  const supported = info.reasoningEfforts?.filter((tier): tier is Exclude<ProviderReasoningEffort, "none"> => tier !== "none");
  if (!supported?.length) return undefined;
  if (supported.includes(effort)) return effort;
  const requested = PROVIDER_EFFORT_ORDER.indexOf(effort);
  return supported.reduce((best, tier) => {
    const distance = Math.abs(PROVIDER_EFFORT_ORDER.indexOf(tier) - requested);
    const bestDistance = Math.abs(PROVIDER_EFFORT_ORDER.indexOf(best) - requested);
    return distance < bestDistance ? tier : best;
  });
}
