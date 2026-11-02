/**
 * xAI SuperGrok subscription OAuth surface.
 *
 * The endpoints and grants are published by the issuer discovery document at
 * https://auth.x.ai/.well-known/openid-configuration. The client id is the
 * shared public Grok CLI client the open-source reference agents use for
 * their SuperGrok device-code logins; xAI issues it without a client secret.
 * Subscription model discovery and inference use the Grok CLI proxy.
 */

import { Redacted } from "effect";

export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
export const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
export const XAI_OAUTH_SCOPES = "openid profile email offline_access grok-cli:access api:access";
export const XAI_SUBSCRIPTION_BASE_URL = "https://cli-chat-proxy.grok.com/v1";

/** Marks a request as the Grok CLI's, which the subscription proxy requires. */
export function applyXaiSubscriptionHeaders(headers: Headers, accessToken: Redacted.Redacted<string>): void {
  // Provider-call adapter: the token is unwrapped only into the header.
  headers.set("authorization", `Bearer ${Redacted.value(accessToken)}`);
  headers.set("X-XAI-Token-Auth", "xai-grok-cli");
  // The subscription proxy rejects Responses requests below its minimum Grok CLI version with HTTP 426,
  // and xAI raises that minimum over time. Raise this version when the proxy starts to refuse it.
  headers.set("x-grok-client-version", "1.0.45");
}
