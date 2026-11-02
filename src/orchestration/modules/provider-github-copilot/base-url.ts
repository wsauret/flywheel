import { Redacted } from "effect";

function validHost(value: string): boolean {
  return value.length <= 253
    && value === value.toLowerCase()
    && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value)
    && !value.includes("..")
    && !value.includes(":");
}

function acceptedProxyHost(value: string): boolean {
  return validHost(value) && (value === "githubcopilot.com" || value.endsWith(".githubcopilot.com"));
}

function acceptedEnterpriseDomain(value: string): boolean {
  return validHost(value) && (value === "github.com" || value.endsWith(".ghe.com"));
}

export interface CopilotAuthUrls {
  readonly deviceCodeUrl: string;
  readonly accessTokenUrl: string;
  readonly copilotTokenUrl: string;
  readonly identityUrl: string;
  readonly quotaUrl: string;
}

function acceptedDomain(domain = "github.com"): string {
  if (!acceptedEnterpriseDomain(domain)) throw new Error("Copilot enterprise domain is not an accepted HTTPS host");
  return domain;
}

/** Returns every bearer-authenticated GitHub endpoint from one validated domain. */
export function getCopilotAuthUrls(enterpriseDomain?: string): CopilotAuthUrls {
  const domain = acceptedDomain(enterpriseDomain);
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`,
    copilotTokenUrl: `https://api.${domain}/copilot_internal/v2/token`,
    identityUrl: domain === "github.com" ? "https://api.github.com/user" : `https://${domain}/api/v3/user`,
    quotaUrl: `https://api.${domain}/copilot_internal/user`,
  };
}

function getBaseUrlFromToken(token: string): string | null {
  const match = token.match(/(?:^|;)proxy-ep=([^;]+)(?:;|$)/);
  if (!match) return null;
  const proxyHost = match[1];
  if (proxyHost === undefined || !acceptedProxyHost(proxyHost)) throw new Error("Copilot proxy endpoint is not an accepted HTTPS host");
  return `https://${proxyHost.replace(/^proxy\./, "api.")}`;
}

/** Swap a request's scheme and host for the Copilot base URL while keeping
 *  path and query. The SDK clients pin `baseURL` at construction, but the
 *  `proxy-ep=` host inside the token can move on refresh, so the per-request
 *  fetch adapter rebases every URL onto the host the current token names
 *  (pi `github-copilot.ts:373-378` derives per request). */
export function rebaseToCopilotHost(url: string | URL | Request, baseUrl: string): string {
  const target = new URL(url instanceof Request ? url.url : url);
  const base = new URL(baseUrl);
  target.protocol = base.protocol;
  target.host = base.host;
  return target.toString();
}

export function getGitHubCopilotBaseUrl(token?: Redacted.Redacted<string>, enterpriseDomain?: string): string {
  if (token) {
    // Routing metadata for the Copilot provider call rides inside the token
    // (`proxy-ep=`); unwrap inline to derive the non-secret host, never
    // retaining the plaintext token.
    const urlFromToken = getBaseUrlFromToken(Redacted.value(token));
    if (urlFromToken) return urlFromToken;
  }
  if (enterpriseDomain) {
    if (!acceptedEnterpriseDomain(enterpriseDomain)) throw new Error("Copilot enterprise domain is not an accepted HTTPS host");
    return `https://copilot-api.${enterpriseDomain}`;
  }
  return "https://api.individual.githubcopilot.com";
}
