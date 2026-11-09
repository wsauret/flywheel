import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { AccessProviderAccessOutcome, AccessProviderAccessProbeInput, AccessProviderCatalogFetchInput, AccessProviderDefinition } from "../../../infra/llm/access-provider.js";
import { DEFAULT_DYNAMIC_CATALOG_LIMITS, type CatalogDiscovery, type CatalogSourceRow } from "../../../infra/llm/model-catalog-resolution.js";
import { classifyFetchFailure } from "../../../infra/llm/model-listing.js";
import { cliLaunch, observationsOf, type ClaudeAgentSdkSeams } from "./cli-launch.js";
import { cliLogin } from "./cli-login.js";

/** A CLI row names its model by the full wire id in `resolvedModel`; `value` is the CLI's own alias for it. */
const WIRE_MODEL_ID = /^claude-[a-z0-9-]+$/u;

type CliModelRow = ModelInfo & { readonly resolvedModel: string };

function isCliModelRow(row: unknown): row is CliModelRow {
  return typeof row === "object" && row !== null
    && "value" in row && typeof row.value === "string" && row.value.length > 0
    && "resolvedModel" in row && typeof row.resolvedModel === "string" && WIRE_MODEL_ID.test(row.resolvedModel);
}

/** The model rows of the CLI's initialize reply, one for each wire model. The CLI lists `default` beside the
 *  alias that resolves to the same model, and a second row for one model would reject the whole catalog, so the
 *  alias row is kept. */
function extractCliModelRows(reply: unknown): readonly unknown[] {
  if (typeof reply !== "object" || reply === null || !("models" in reply) || !Array.isArray(reply.models)) throw new TypeError("the CLI model list must be an array");
  const byModel = new Map<string, CliModelRow>();
  for (const row of reply.models) {
    if (!isCliModelRow(row)) continue;
    const kept = byModel.get(row.resolvedModel);
    if (kept === undefined || kept.value === "default") byModel.set(row.resolvedModel, row);
  }
  return [...byModel.values()];
}

/** The CLI row carries no limits, names, or dates, so models.dev supplies them; the row keeps what only the CLI
 *  states. */
function canonicalizeCliModelRow(row: unknown): CatalogSourceRow | undefined {
  if (!isCliModelRow(row)) return undefined;
  return {
    modelId: row.resolvedModel,
    wireModelId: row.resolvedModel,
    metadata: { cli_value: row.value, ...(row.supportedEffortLevels === undefined ? {} : { supported_effort_levels: [...row.supportedEffortLevels] }) },
  };
}

/**
 * Asks the CLI that owns the login for the models it offers, launched as the provider's queries are. The CLI starts
 * only in the listing caller's launch scope. The plan that the CLI names for the login is kept for the account rows. A CLI with no login is an invalid credential, as a refused key is on the native provider.
 */
async function discoverCliModels({ credential, instance, launcher, signal }: AccessProviderCatalogFetchInput, seams: ClaudeAgentSdkSeams): Promise<CatalogDiscovery> {
  const launch = cliLaunch(credential, launcher, seams);
  if (launch.kind === "no-login") return { kind: "auth-invalid" };
  if (launch.kind !== "ready") return { kind: "failed", reason: "transport" };
  try {
    // The Agent SDK loads only when a listing asks a CLI, so a process that never does keeps it out of its start.
    const describeLogin = seams.describeLogin ?? (await import("./query-launcher.js")).describeCliLogin;
    const described = await describeLogin(launch.config, signal);
    if (described.plan !== undefined && instance !== undefined) observationsOf(seams).recordPlan({ configDir: launch.config.configDir, accountId: instance.instanceId }, described.plan);
    return described.loggedIn ? { kind: "rows", rows: extractCliModelRows(described) } : { kind: "auth-invalid" };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    return classifyFetchFailure(error);
  }
}

/** How long one access probe may take: the engine's start and one short response. A probe past it is inconclusive. */
const ACCESS_PROBE_TIMEOUT_MS = 60_000;

/**
 * Asks the login whether it serves one model with one minimal request through the CLI that owns the login, launched
 * in the listing caller's scope as the provider's queries are. A check never uses overage (PI-MODEL-065): a
 * usage-billed (metered) login bills every request as an API key does, so its check is one ordinary billed request,
 * and a subscription login is checked only while its extra usage is off, so a spent allowance refuses the request
 * instead of billing it. A subscription login whose extra usage is on or unknown sends nothing and is inconclusive. A
 * login or engine that cannot start, and a probe past its deadline, are inconclusive too; the probe's messages decide
 * the rest (`probeOutcome`).
 */
async function probeCliModelAccess({ credential, launcher, wireModelId, signal }: AccessProviderAccessProbeInput, seams: ClaudeAgentSdkSeams): Promise<AccessProviderAccessOutcome> {
  const launch = cliLaunch(credential, launcher, seams);
  if (launch.kind !== "ready") return "inconclusive";
  const login = cliLogin(launch.config.configDir);
  const metered = login?.account.billing === "metered";
  if (login === undefined || (!metered && login.extraUsage !== "disabled")) return "inconclusive";
  try {
    // The Agent SDK loads only when an audit probes, as for the listing.
    const [{ probeCliModel }, { probeOutcome }] = await Promise.all([import("./query-launcher.js"), import("./sdk-events.js")]);
    const probe = seams.probeModel ?? probeCliModel;
    return probeOutcome(await probe(launch.config, wireModelId, AbortSignal.any([signal, AbortSignal.timeout(ACCESS_PROBE_TIMEOUT_MS)])), metered);
  } catch {
    if (signal.aborted) throw signal.reason;
    return "inconclusive";
  }
}

/**
 * The provider's catalog: the CLI's lineup, which serves at once, and the models.dev `anthropic` rows that the lineup
 * does not name. The CLI offers a curated lineup, not every model the login serves, so those rows are offered too, but
 * each serves only after an access probe on the login completed (PI-MODEL-065). The listing owns every discovery mode,
 * the saved catalog, and the audit, as for every other provider.
 */
export function claudeSdkDynamicCatalog(seams: ClaudeAgentSdkSeams): NonNullable<AccessProviderDefinition["dynamicCatalog"]> {
  return {
    limits: DEFAULT_DYNAMIC_CATALOG_LIMITS,
    extractRows: extractCliModelRows,
    canonicalize: canonicalizeCliModelRow,
    modelsDevCatalogIds: ["anthropic"],
    liveMembership: "extends-baseline",
    fetch: async (input) => ({ discovery: await discoverCliModels(input, seams), credential: input.credential }),
    probeAccess: (input) => probeCliModelAccess(input, seams),
    // Each probe launches an engine, and its inconclusive answers, such as a spent allowance, speak for the login.
    inconclusiveEndsPass: true,
  };
}
