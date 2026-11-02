import type { CatalogJsonValue } from "./model-catalog-resolution.js";
import type { ModelPricing } from "./models.js";

const PRICING_URL = "https://developers.openai.com/api/docs/pricing.md";
const MAX_PRICING_BYTES = 512 * 1024;
const LONG_CONTEXT_THRESHOLD = 272_000;
const COMPLETED_REFRESH_WINDOW_MS = 5_000;
let currentPricing: ReadonlyMap<string, OpenAiRateCard> = new Map();
let refreshInFlight: Promise<void> | undefined;
let refreshCompletedAt = Number.NEGATIVE_INFINITY;

interface OpenAiRateTier {
  readonly input: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly output: number;
}

interface OpenAiRateCard extends OpenAiRateTier {
  readonly highContext?: OpenAiRateTier & { readonly threshold: number };
}

function price(value: string): number | undefined {
  const normalized = value.trim();
  if (normalized === "-") return undefined;
  if (!/^\$\d+(?:\.\d+)?$/.test(normalized)) return undefined;
  const parsed = Number(normalized.slice(1));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Reads one input, cached input, cache write, output column group. Input and output are required. */
function rateTier([inputCell, cacheReadCell, cacheWriteCell, outputCell]: readonly string[]): OpenAiRateTier | undefined {
  const input = price(inputCell ?? "");
  const output = price(outputCell ?? "");
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = price(cacheReadCell ?? "");
  const cacheWrite = price(cacheWriteCell ?? "");
  return { input, ...(cacheRead === undefined ? {} : { cacheRead }), ...(cacheWrite === undefined ? {} : { cacheWrite }), output };
}

/** Parses only OpenAI's named Standard table. Any structural drift fails closed. */
export function parseOpenAiStandardPricing(markdown: string): ReadonlyMap<string, OpenAiRateCard> {
  const start = markdown.indexOf("### Standard pricing data");
  if (start < 0) return new Map();
  const rest = markdown.slice(start);
  const end = rest.slice(1).search(/\n### /);
  const section = end < 0 ? rest : rest.slice(0, end + 1);
  const result = new Map<string, OpenAiRateCard>();
  for (const line of section.split("\n")) {
    if (!line.startsWith("| ") || line.startsWith("| Model ") || line.startsWith("| ---")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 9 || !/^[a-z0-9][a-z0-9._-]*(?: \(<[^)]+\))?$/.test(cells[0] ?? "")) continue;
    const model = cells[0]?.replace(/ \(<[^)]+\)$/, "");
    if (!model || result.has(model)) return new Map();
    // A "-" cell means OpenAI lists no rate for that column, as for cache writes on older models.
    const short = rateTier(cells.slice(1, 5));
    if (short === undefined) continue;
    const long = rateTier(cells.slice(5, 9));
    result.set(model, { ...short, ...(long === undefined ? {} : { highContext: { threshold: LONG_CONTEXT_THRESHOLD, ...long } }) });
  }
  return result;
}

export async function fetchOpenAiStandardPricing(signal: AbortSignal): Promise<ReadonlyMap<string, OpenAiRateCard>> {
  try {
    const response = await fetch(PRICING_URL, { signal });
    if (!response.ok || response.headers.get("content-type")?.startsWith("text/markdown") !== true) return new Map();
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_PRICING_BYTES) return new Map();
    const markdown = await readBoundedText(response, MAX_PRICING_BYTES);
    return parseOpenAiStandardPricing(markdown);
  } catch {
    return new Map();
  }
}

/** Returns the last completed official OpenAI rate-card snapshot without I/O. */
export function currentOpenAiStandardPricing(): ReadonlyMap<string, OpenAiRateCard> {
  return currentPricing;
}

/** Coalesces optional provider-document enrichment. Callers never await it for model admission. */
export function refreshOpenAiStandardPricing(): Promise<void> {
  if (Date.now() - refreshCompletedAt < COMPLETED_REFRESH_WINDOW_MS) return Promise.resolve();
  refreshInFlight ??= fetchOpenAiStandardPricing(AbortSignal.timeout(10_000))
    .then((pricing) => {
      if (pricing.size > 0) currentPricing = pricing;
    })
    .finally(() => {
      refreshCompletedAt = Date.now();
      refreshInFlight = undefined;
    });
  return refreshInFlight;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new TypeError("OpenAI pricing response body is missing");
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    byteLength += next.value.byteLength;
    if (byteLength > maxBytes) {
      await reader.cancel();
      throw new TypeError("OpenAI pricing response exceeds the size limit");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function openAiPricingMetadata(model: string, rateCards: ReadonlyMap<string, OpenAiRateCard>): CatalogJsonValue | undefined {
  const rateCard = rateCards.get(model);
  return rateCard === undefined ? undefined : {
    standardPricing: {
      ...rateTierMetadata(rateCard),
      ...(rateCard.highContext === undefined ? {} : { highContext: { threshold: rateCard.highContext.threshold, ...rateTierMetadata(rateCard.highContext) } }),
    },
  };
}

function rateTierMetadata(tier: OpenAiRateTier) {
  return {
    input: tier.input,
    output: tier.output,
    ...(tier.cacheRead === undefined ? {} : { cacheRead: tier.cacheRead }),
    ...(tier.cacheWrite === undefined ? {} : { cacheWrite: tier.cacheWrite }),
  };
}

export function openAiPricingFromMetadata(value: unknown, model: string): ModelPricing | undefined {
  if (!record(value) || !record(value.standardPricing)) return undefined;
  const rate = value.standardPricing;
  if (!nonNegative(rate.input) || !nonNegative(rate.output)
    || !optionalNonNegative(rate.cacheRead) || !optionalNonNegative(rate.cacheWrite) || !optionalNonNegative(rate.reasoning)) return undefined;
  if (rate.highContext !== undefined && (!record(rate.highContext)
    || !positiveInteger(rate.highContext.threshold)
    || !nonNegative(rate.highContext.input)
    || !nonNegative(rate.highContext.output)
    || !optionalNonNegative(rate.highContext.cacheRead)
    || !optionalNonNegative(rate.highContext.cacheWrite)
    || !optionalNonNegative(rate.highContext.reasoning))) return undefined;
  const high = record(rate.highContext) ? rate.highContext : undefined;
  const highThreshold = high?.threshold;
  const highInput = high?.input;
  const highOutput = high?.output;
  return {
    status: "available",
    rateCard: {
      input: rate.input,
      output: rate.output,
      ...(typeof rate.cacheRead === "number" ? { cacheRead: rate.cacheRead } : {}),
      ...(typeof rate.cacheWrite === "number" ? { cacheWrite: rate.cacheWrite } : {}),
      ...(typeof rate.reasoning === "number" ? { reasoning: rate.reasoning } : {}),
      ...(typeof highThreshold !== "number" || typeof highInput !== "number" || typeof highOutput !== "number" ? {} : {
        highContext: {
          threshold: highThreshold,
          input: highInput,
          output: highOutput,
          ...(typeof high?.cacheRead === "number" ? { cacheRead: high.cacheRead } : {}),
          ...(typeof high?.cacheWrite === "number" ? { cacheWrite: high.cacheWrite } : {}),
          ...(typeof high?.reasoning === "number" ? { reasoning: high.reasoning } : {}),
        },
      }),
    },
    provenance: { source: "provider-docs", provider: "openai", model },
  };
}

interface UnknownRecord { readonly [key: string]: unknown }

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function optionalNonNegative(value: unknown): boolean {
  return value === undefined || nonNegative(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
