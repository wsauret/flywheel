import { candidateProviderId } from "../../../infra/llm/access-provider.js";
import { captureRoleCatalog, type CapturedRoleSelection } from "../../config/role-resolution.js";
import { effortOptionsForMetadata } from "../../agent-runtime/llm/model-compat.js";
import type { CaptureProviderConnection } from "../../agent-runtime/factory.js";
import { claudeKnowledgeCutoff } from "../../agent-runtime/llm/claude-reminders.js";
import type { AdvertisedTool, RuntimeTool } from "../../agent-runtime/tools/types.js";
import { readModelScores, scoresForModel } from "../../../infra/llm/model-scores.js";
import type { ModelScoreSnapshot } from "../../../infra/llm/model-scores-document.js";
import { scoreCatalogModels } from "../../config/model-score-scope.js";
import { getSharedModelsClient } from "../../config/llm-clients.js";

function selection(result: CapturedRoleSelection): { readonly model: string; readonly effort: string } | { readonly unavailable: string } {
  return result.kind === "selected" ? { model: result.role.model, effort: result.role.effort } : { unavailable: result.kind };
}

/** The advertised form of the models tool, which serves choosing the models of
 *  workflow agents, so it leaves with the Workflows module. It names no model
 *  access capture, so an agent without one advertises the same bytes. */
export const MODELS_TOOL_DEFINITION: AdvertisedTool = {
  name: "models",
  action: "ui_meta",
  description: "List the models this session can use now, with metadata, prices per million tokens, supported efforts, context windows, tier resolutions, and the Workflow Agent default. Read this before choosing a workflow agent's model or effort. This read-only call reflects current profile access and enabled models; it changes no settings.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  isConcurrencySafe: true,
  // Truncation would corrupt the table; size is bounded by the account's model catalog.
  uncappedOutput: true,
};

/** Reads current eligibility on execution. Catalog data never enters tool definitions or prompt guidance. */
export function createModelsTool(
  captureConnection: CaptureProviderConnection,
  userDataRoot: string,
  readScores: () => Promise<ModelScoreSnapshot | undefined> = () => readModelScores(userDataRoot),
  readScope: () => readonly string[] = () => scoreCatalogModels(new Date(), getSharedModelsClient(userDataRoot)),
): RuntimeTool {
  return {
    ...MODELS_TOOL_DEFINITION,
    async execute() {
      const capture = await captureConnection();
      const catalog = captureRoleCatalog({
        selection: capture.providers.selection, connection: capture.connection, eligibility: capture.eligibility,
        allowTrainingRoutes: capture.runtimeConfig.allowTrainingRoutes,
      }, userDataRoot);
      const scoreSnapshot = await readScores();
      const scope = scoreSnapshot === undefined ? [] : readScope();
      const plans = [...catalog.plans.values()];
      const modelScores = plans.map((plan) => scoresForModel(plan.model, scoreSnapshot, scope, effortOptionsForMetadata(plan.candidateAttributions[0]?.resolvedModelMetadata)));
      const scoresUnavailableReason = scoreSnapshot === undefined
        ? "Tiers unavailable: no cached benchmark data."
        : undefined;
      const columns = ["id", "name", "providers", "releaseDate", "knowledgeCutoff", "inputPerMillion", "cachedInputPerMillion", "outputPerMillion", "supportedEfforts", "contextWindow"];
      if (scoreSnapshot !== undefined) columns.push("tiersUnavailableReason", "qualityEffortNote");
      const rows = plans.map((plan, index) => {
        const info = plan.candidateAttributions[0]?.resolvedModelMetadata;
        const price = info?.pricing.status === "available" ? info.pricing.rateCard : undefined;
        const reason = modelScores[index]?.scoresUnavailableReason;
        return [
          plan.model, info?.name ?? plan.model,
          [...new Set(plan.candidates.map((candidate) => capture.providers.selection.displayName(candidateProviderId(candidate))))],
          info?.releaseDate ?? null,
          info?.knowledgeCutoff ?? claudeKnowledgeCutoff(plan.model) ?? null,
          price?.input ?? null, price?.cacheRead ?? null, price?.output ?? null,
          effortOptionsForMetadata(info), info?.contextLimit ?? null,
          ...(scoreSnapshot === undefined ? [] : [reason ?? null, modelScores[index]?.qualityEffortNote ?? null]),
        ];
      });
      const tiers = Object.fromEntries(await Promise.all(["cheap", "mid", "powerful"].map(async (tier) => {
        const resolved = await catalog.resolve("workflow-agent", { model: tier });
        return [tier, resolved.kind === "selected" ? { model: resolved.role.model } : { unavailable: resolved.kind }];
      })));
      const workflowAgentDefault = selection(await catalog.resolve("workflow-agent", capture.runtimeConfig.profileRoles["workflow-agent"] ?? {}));
      return {
        outcome: "ok",
        content: JSON.stringify({
          models: { columns, rows }, tiers, workflowAgentDefault,
          tiersUnavailableReason: scoresUnavailableReason,
          attribution: "Tiers derived by Flywheel from Terminal-Bench and BenchLM.ai data.",
          notes: "Each table's rows follow its columns; modelTiers join models by id and effort. All tiers range from 1 to 10: higher means better quality, faster speed, or lower cost. They are relative to recent first-party models, not the cheap/mid/powerful role preferences. Prices are USD per 1M tokens. Context windows are input tokens. Null means unavailable. Availability can change before launch; the launch result reports actual selections.",
          ...(scoreSnapshot === undefined ? {} : {
            modelTiers: {
              columns: ["model", "effort", "qualityTier", "speedTier", "costTier"],
              rows: plans.flatMap((plan, index) => (modelScores[index]?.scores ?? []).map((score) => [
                plan.model, score.effort, score.qualityTier, score.speedTier, score.costTier,
              ])),
            },
            tiersUpdatedAt: scoreSnapshot.fetchedAt,
            terminalBenchAvailable: scoreSnapshot.terminalAvailable,
          }),
        }),
      };
    },
  };
}
