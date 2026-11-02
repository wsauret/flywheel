import { Redacted } from "effect";
import { unsupportedSubscriptionUsageOutcome, type SubscriptionUsageReader, type SubscriptionUsageSpendSource } from "../../../infra/llm/subscription-usage.js";
import { malformed, prepaidBalance, readerIdentity, requiredRecord, requiredString, usageJson, usageReport, usageRequest, type FetchLike } from "../../../infra/llm/subscription-usage-reader.js";

const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

/** DeepSeek states each balance as a decimal string per currency, and
 *  `is_available: false` when the balance cannot pay for a request. */
function deepseekBalance(raw: unknown) {
  const payload = requiredRecord(raw, "DeepSeek", "response");
  if (typeof payload.is_available !== "boolean") throw malformed("DeepSeek", "is_available is missing or invalid");
  if (!Array.isArray(payload.balance_infos)) throw malformed("DeepSeek", "balance_infos is missing or invalid");
  const spendSources = payload.balance_infos.map((value): SubscriptionUsageSpendSource => {
    const info = requiredRecord(value, "DeepSeek", "balance_infos entry");
    const currency = requiredString(info, "currency", "DeepSeek");
    const total = Number(requiredString(info, "total_balance", "DeepSeek"));
    if (!Number.isFinite(total) || total < 0) throw malformed("DeepSeek", "total_balance is invalid");
    return prepaidBalance({ kind: "money", value: total, currency, provenance: "provider", precision: "exact" });
  });
  return { spendSources, status: payload.is_available ? "ok" as const : "exhausted" as const };
}

/** Reads the prepaid balance of a DeepSeek API key. */
export function createDeepSeekUsageReader(fetchImpl: FetchLike = fetch): SubscriptionUsageReader {
  return async (context) => {
    if (readerIdentity(context) === undefined) return { kind: "identity-unavailable" };
    if (context.account.credential.type !== "api_key") return unsupportedSubscriptionUsageOutcome();
    // Provider-call adapter: the key is unwrapped only into the header.
    const response = await usageRequest(fetchImpl, DEEPSEEK_BALANCE_URL, { accept: "application/json", authorization: `Bearer ${Redacted.value(context.account.credential.key)}` }, context.signal, "unsupported");
    if (!(response instanceof Response)) return response;
    const decoded = await usageJson(response);
    if (decoded.kind === "failed") return decoded.outcome;
    try {
      const balance = deepseekBalance(decoded.value);
      return usageReport(context, [], balance);
    } catch {
      return { kind: "fetch-failure" };
    }
  };
}
