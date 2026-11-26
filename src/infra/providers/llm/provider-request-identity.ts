import os from "node:os";
import { readAppVersion } from "../../update/distribution/app-version.js";

const OPENROUTER_REFERER = "https://github.com/wsauret/flywheel";
const OPENROUTER_TITLE = "Flywheel";
const OPENCODE_GO_CLIENT = "flywheel";
/** The headers through which the OpenCode Go service attributes a request to its client and its session. */
const OPENCODE_GO_CLIENT_HEADER = "x-opencode-client";
const OPENCODE_GO_SESSION_HEADER = "x-opencode-session";

interface StringHeaders {
  readonly [name: string]: string;
}

interface ProviderRequestHeaders extends StringHeaders {
  readonly "User-Agent": string;
}

interface OpenRouterRequestHeaders extends ProviderRequestHeaders {
  readonly "HTTP-Referer": string;
  readonly "X-Title": string;
}

interface OpenCodeGoRequestHeaders extends ProviderRequestHeaders {
  readonly [OPENCODE_GO_CLIENT_HEADER]: string;
  readonly [OPENCODE_GO_SESSION_HEADER]: string;
}

/** Returns headers shared by inference and model-catalog requests, with Flywheel's canonical identity as the user agent. */
export async function providerRequestHeaders(): Promise<ProviderRequestHeaders> {
  return { "User-Agent": `flywheel/${await readAppVersion()} (${os.platform()}; ${os.arch()})` };
}

export async function openRouterRequestHeaders(): Promise<OpenRouterRequestHeaders> {
  return { ...await providerRequestHeaders(), "HTTP-Referer": OPENROUTER_REFERER, "X-Title": OPENROUTER_TITLE };
}

export async function openCodeGoRequestHeaders(providerSessionKey: string | undefined): Promise<OpenCodeGoRequestHeaders> {
  if (!providerSessionKey) throw new TypeError("OpenCode Go requests require a provider session key");
  return { ...await providerRequestHeaders(), [OPENCODE_GO_CLIENT_HEADER]: OPENCODE_GO_CLIENT, [OPENCODE_GO_SESSION_HEADER]: providerSessionKey };
}
