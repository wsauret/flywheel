import type { Credential } from "./auth-store-types.js";

/** Compares complete credential identity without exposing secret bytes. */
export function credentialsEqual(left: Credential | undefined, right: Credential): boolean {
  if (left?.type !== right.type) return false;
  if (left.type === "api_key" && right.type === "api_key") return left.key === right.key;
  if (left.type !== "oauth" || right.type !== "oauth") return false;
  return left.access === right.access
    && left.refresh === right.refresh
    && left.expires === right.expires
    && left.accountId === right.accountId
    && left.enterpriseDomain === right.enterpriseDomain;
}
