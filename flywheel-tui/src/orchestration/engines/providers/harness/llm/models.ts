/**
 * models.dev client with 24h on-disk caching.
 *
 * The API returns a large document covering many providers and models.
 * We cache to MODELS_CACHE_DIR/models.json and refresh on a 24h TTL.
 * If the API is unreachable and cache is stale, we still use stale cache.
 * If no cache exists and the API fails, getModelInfo returns null and the
 * caller falls back to prefix-based heuristics.
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { Log } from "../../../../../infra/log.js";
import { MODELS_CACHE_DIR } from "../../../../../infra/paths.js";
import { detectModelFamily, inferModelFamilyFromProvider } from "./model-family.js";

const log = Log.create({ service: "llm-models" });

const API_URL = "https://models.dev/api.json";
const CACHE_FILE = join(MODELS_CACHE_DIR, "models.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

export interface ModelInfo {
  provider: string;
  family: ReturnType<typeof inferModelFamilyFromProvider>;
  id: string;
  name: string;
  reasoning: boolean;
  toolCall: boolean;
  attachment: boolean;
  temperature: boolean;
  contextLimit: number;
  outputLimit: number;
  cost: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  modalities: { input: string[]; output: string[] };
}

interface RawModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  attachment?: boolean;
  temperature?: boolean;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  modalities?: { input?: string[]; output?: string[] };
}

interface RawProvider {
  name: string;
  env?: string[];
  models: Record<string, RawModel>;
}

type RawApi = Record<string, RawProvider>;

export interface ModelsClient {
  getModelInfo(modelId: string, providerHint?: string): Promise<ModelInfo | null>;
}

export function createModelsClient(): ModelsClient {
  let inMemory: RawApi | null = null;
  let inFlightPromise: Promise<RawApi | null> | null = null;

  async function loadCache(): Promise<{ data: RawApi; stale: boolean } | null> {
    try {
      const file = Bun.file(CACHE_FILE);
      const stats = await file.stat();
      if (!stats) return null;
      const ageMs = Date.now() - stats.mtimeMs;
      const text = await file.text();
      return { data: JSON.parse(text) as RawApi, stale: ageMs > CACHE_TTL_MS };
    } catch {
      return null;
    }
  }

  async function fetchFresh(): Promise<RawApi | null> {
    try {
      const res = await fetch(API_URL, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      const data = (await res.json()) as RawApi;
      try {
        mkdirSync(MODELS_CACHE_DIR, { recursive: true });
        await Bun.write(CACHE_FILE, JSON.stringify(data));
      } catch {
        log.warn("Failed to write models cache to disk");
      }
      return data;
    } catch {
      log.warn("Failed to fetch models from models.dev API");
      return null;
    }
  }

  async function loadApi(): Promise<RawApi | null> {
    if (inMemory) return inMemory;
    if (inFlightPromise) return inFlightPromise;

    inFlightPromise = (async () => {
      try {
        const cached = await loadCache();
        if (cached && !cached.stale) {
          inMemory = cached.data;
          return cached.data;
        }
        const fresh = await fetchFresh();
        if (fresh) {
          inMemory = fresh;
          return fresh;
        }
        if (cached) {
          inMemory = cached.data;
          return cached.data;
        }
        return null;
      } finally {
        inFlightPromise = null;
      }
    })();

    return inFlightPromise;
  }

  function normalize(provider: string, raw: RawModel): ModelInfo {
    return {
      provider,
      family: inferModelFamilyFromProvider(provider),
      id: raw.id,
      name: raw.name ?? raw.id,
      reasoning: raw.reasoning ?? false,
      toolCall: raw.tool_call ?? false,
      attachment: raw.attachment ?? false,
      temperature: raw.temperature ?? true,
      contextLimit: raw.limit?.context ?? 200_000,
      outputLimit: raw.limit?.output ?? 4_096,
      cost: {
        input: raw.cost?.input ?? 0,
        output: raw.cost?.output ?? 0,
        cacheRead: raw.cost?.cache_read,
        cacheWrite: raw.cost?.cache_write,
      },
      modalities: {
        input: raw.modalities?.input ?? ["text"],
        output: raw.modalities?.output ?? ["text"],
      },
    };
  }

  return {
    async getModelInfo(modelId: string, providerHint?: string): Promise<ModelInfo | null> {
      const api = await loadApi();
      if (!api) return null;

      const candidates: string[] = [];
      if (providerHint) candidates.push(providerHint);
      const family = detectModelFamily(modelId);
      if (family && !candidates.includes(family)) candidates.push(family);

      for (const providerId of candidates) {
        const p = api[providerId];
        if (p?.models[modelId]) return normalize(providerId, p.models[modelId]);
      }

      for (const [providerId, provider] of Object.entries(api)) {
        if (candidates.includes(providerId)) continue;
        if (provider.models?.[modelId]) {
          return normalize(providerId, provider.models[modelId]);
        }
      }
      return null;
    },
  };
}
