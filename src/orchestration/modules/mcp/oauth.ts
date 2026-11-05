import { createServer, type Server } from "node:http";
import {
  auth,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { Redacted } from "effect";
import type {
  McpCredential,
  McpCredentialStore,
  McpOAuthClientInformation,
  McpOAuthTokens,
} from "./credentials.js";
import { McpOAuthNeedsAuthError, McpRegistrationRefusedError } from "./errors.js";

const REFRESH_SKEW_MS = 30_000;

interface OAuthArtifactStore {
  tokens(): Promise<OAuthTokens | undefined>;
  saveTokens(tokens: OAuthTokens): Promise<void>;
  clientInformation(): Promise<OAuthClientInformationMixed | undefined>;
  saveClientInformation(info: OAuthClientInformationMixed): Promise<void>;
  codeVerifier(): Promise<string | undefined>;
  saveCodeVerifier(verifier: string): Promise<void>;
}

/** An OAuth client registered with the authorization server ahead of time, for a
 *  server that does not support dynamic client registration. While one is set,
 *  Flywheel never registers a client for that server. */
export interface McpPreregisteredClient {
  readonly clientId: string;
  readonly clientSecret?: Redacted.Redacted<string>;
}

interface McpOAuthProviderOptions {
  readonly client: McpPreregisteredClient | undefined;
  readonly redirectUrl?: string;
  readonly scope?: string;
  readonly state?: string;
  readonly store: OAuthArtifactStore;
  readonly onRedirect: (url: URL) => void | Promise<void>;
  readonly invalidate?: (scope: "all" | "client" | "tokens" | "verifier" | "discovery") => void | Promise<void>;
}

export interface McpSilentOAuth {
  readonly provider: OAuthClientProvider;
  readonly secrets: Redacted.Redacted<string>[];
  /** Refreshes an expiring token. `signal` is the connection attempt's signal:
   *  it carries the attempt deadline, so a refresh cannot outlive the attempt
   *  that asked for it. */
  refreshIfNeeded(signal: AbortSignal): Promise<void>;
}

export interface McpOAuthAuthorization {
  /** The page the person opens to sign in, or nothing when the server is already signed in. */
  readonly url: string | undefined;
  readonly redirectUrl: string;
  complete(): Promise<void>;
  close(): Promise<void>;
}

function createMcpOAuthProvider(options: McpOAuthProviderOptions): OAuthClientProvider {
  const client = options.client;
  return {
    redirectUrl: options.redirectUrl,
    clientMetadata: {
      redirect_uris: options.redirectUrl === undefined ? [] : [options.redirectUrl],
      client_name: "Flywheel",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(options.scope === undefined ? {} : { scope: options.scope }),
    },
    ...(options.state === undefined ? {} : { state: () => options.state ?? "" }),
    // A pre-registered client offers no saveClientInformation, so the SDK neither
    // registers nor persists a client for it.
    ...(client === undefined
      ? {
        clientInformation: () => options.store.clientInformation(),
        saveClientInformation: (info: OAuthClientInformationMixed) => options.store.saveClientInformation(info),
      }
      : {
        clientInformation: () => ({
          client_id: client.clientId,
          ...(client.clientSecret === undefined ? {} : { client_secret: Redacted.value(client.clientSecret) }),
        }),
      }),
    tokens: () => options.store.tokens(),
    saveTokens: (tokens) => options.store.saveTokens(tokens),
    redirectToAuthorization: (url) => options.onRedirect(url),
    saveCodeVerifier: (verifier) => options.store.saveCodeVerifier(verifier),
    codeVerifier: async () => {
      const verifier = await options.store.codeVerifier();
      if (verifier === undefined) throw new Error("Missing PKCE code verifier for MCP OAuth flow");
      return verifier;
    },
    ...(options.invalidate === undefined ? {} : { invalidateCredentials: options.invalidate }),
  };
}

export function createSilentMcpOAuth(
  server: string,
  url: string,
  credentialStore: McpCredentialStore,
  credential: McpCredential | undefined,
  client: McpPreregisteredClient | undefined,
): McpSilentOAuth {
  let current = credential ?? {};
  const secrets: Redacted.Redacted<string>[] = [];
  collectSecrets(current, secrets);
  if (client?.clientSecret !== undefined) secrets.push(client.clientSecret);
  const persist = async (): Promise<void> => {
    await credentialStore.save(server, url, current);
  };
  const store: OAuthArtifactStore = {
    tokens: async () => current.tokens === undefined ? undefined : toSdkTokens(current.tokens),
    saveTokens: async (tokens) => {
      current = { ...current, tokens: fromSdkTokens(tokens) };
      collectSecrets(current, secrets);
      await persist();
    },
    clientInformation: async () => current.clientInformation === undefined
      ? undefined
      : toSdkClientInformation(current.clientInformation),
    saveClientInformation: async (clientInformation) => {
      current = { ...current, clientInformation: fromSdkClientInformation(clientInformation) };
      collectSecrets(current, secrets);
      await persist();
    },
    codeVerifier: async () => current.codeVerifier === undefined ? undefined : Redacted.value(current.codeVerifier),
    saveCodeVerifier: async (verifier) => {
      current = { ...current, codeVerifier: Redacted.make(verifier) };
      collectSecrets(current, secrets);
      await persist();
    },
  };
  const provider = createMcpOAuthProvider({
    client,
    redirectUrl: "http://127.0.0.1/callback",
    store,
    onRedirect: () => {},
    invalidate: async (scope) => {
      if (scope === "all") current = {};
      if (scope === "client") current = { ...current, clientInformation: undefined };
      if (scope === "tokens") current = { ...current, tokens: undefined };
      if (scope === "verifier") current = { ...current, codeVerifier: undefined };
      if (scope !== "discovery") await persist();
    },
  });
  return {
    provider,
    secrets,
    async refreshIfNeeded(signal) {
      const expiresAt = current.tokens?.expiresAt;
      if (expiresAt === undefined || expiresAt - Date.now() > REFRESH_SKEW_MS) return;
      const refreshToken = current.tokens?.refreshToken;
      if (refreshToken === undefined) throw new McpOAuthNeedsAuthError();
      const result = await auth(provider, { serverUrl: url, fetchFn: boundFetch(signal) });
      if (result !== "AUTHORIZED") throw new McpOAuthNeedsAuthError();
    },
  };
}

/** Applies one connection attempt's signal to every OAuth request the SDK makes,
 *  without dropping a signal the SDK supplies itself. */
function boundFetch(signal: AbortSignal): FetchLike {
  return async (url, init) => await fetch(url, {
    ...init,
    signal: init?.signal == null ? signal : AbortSignal.any([init.signal, signal]),
  });
}

interface McpCredentialRef { current: McpCredential }

export async function authorizeMcpServer(input: {
  readonly server: string;
  readonly url: string;
  readonly credentialStore: McpCredentialStore;
  readonly client: McpPreregisteredClient | undefined;
  readonly scope?: string;
  readonly callbackPort?: number;
}): Promise<McpOAuthAuthorization> {
  const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  // A new authorization replaces the OAuth artifacts but keeps what the user
  // stored for this server outside OAuth: secret headers and the client secret.
  const stored = input.credentialStore.get(input.server, input.url);
  const credential: McpCredentialRef = {
    current: {
      ...(stored?.headers === undefined ? {} : { headers: stored.headers }),
      ...(stored?.clientSecret === undefined ? {} : { clientSecret: stored.clientSecret }),
    },
  };
  let settleCode = (_code: string): void => {};
  let rejectCode = (_error: Error): void => {};
  const code = new Promise<string>((resolve, reject) => {
    settleCode = resolve;
    rejectCode = reject;
  });
  const server = createCallbackServer(state, settleCode, rejectCode);
  const port = await listen(server, input.callbackPort);
  const redirectUrl = `http://127.0.0.1:${port}/callback`;
  let authorizationUrl: URL | undefined;
  // The SDK reads the client information after discovery and registers a client when there is none, then saves it.
  // A failure between the two is a refused registration (`McpRegistrationRefusedError`) when the server answered
  // with an OAuth error or its metadata names no registration endpoint; a network failure is not.
  let registering = false;
  const store: OAuthArtifactStore = {
    tokens: async () => credential.current.tokens === undefined ? undefined : toSdkTokens(credential.current.tokens),
    saveTokens: async (tokens) => { credential.current = { ...credential.current, tokens: fromSdkTokens(tokens) }; },
    clientInformation: async () => {
      if (credential.current.clientInformation === undefined) {
        registering = input.client === undefined;
        return undefined;
      }
      return toSdkClientInformation(credential.current.clientInformation);
    },
    saveClientInformation: async (clientInformation) => {
      registering = false;
      credential.current = { ...credential.current, clientInformation: fromSdkClientInformation(clientInformation) };
    },
    codeVerifier: async () => credential.current.codeVerifier === undefined
      ? undefined
      : Redacted.value(credential.current.codeVerifier),
    saveCodeVerifier: async (verifier) => {
      credential.current = { ...credential.current, codeVerifier: Redacted.make(verifier) };
    },
  };
  const provider = createMcpOAuthProvider({
    client: input.client,
    redirectUrl,
    scope: input.scope,
    state,
    store,
    onRedirect: (url) => { authorizationUrl = url; },
  });
  try {
    const result = await auth(provider, { serverUrl: input.url, scope: input.scope });
    if (result === "AUTHORIZED") {
      await input.credentialStore.save(input.server, input.url, credential.current);
      return { url: undefined, redirectUrl, complete: async () => {}, close: () => closeServer(server) };
    }
    if (authorizationUrl === undefined) throw new Error(`MCP server '${input.server}' did not provide an authorization URL`);
  } catch (error) {
    await closeServer(server);
    if (registering && registrationRefused(error)) throw new McpRegistrationRefusedError(input.server, { cause: error });
    throw error;
  }
  return {
    url: authorizationUrl.toString(),
    redirectUrl,
    async complete() {
      try {
        const authorizationCode = await code;
        const result = await auth(provider, { serverUrl: input.url, authorizationCode, scope: input.scope });
        if (result !== "AUTHORIZED") throw new Error(`MCP server '${input.server}' did not authorize`);
        await input.credentialStore.save(input.server, input.url, credential.current);
      } finally {
        await closeServer(server);
      }
    },
    close: () => closeServer(server),
  };
}

/** Whether a failure during client registration came from the authorization server: an OAuth error answer, or
 *  metadata with no registration endpoint, which the SDK reports only in its message (SDK 1.x `registerClient`). */
function registrationRefused(error: unknown): boolean {
  return error instanceof OAuthError || error instanceof Error && error.message.includes("does not support dynamic client registration");
}

export function toSdkTokens(tokens: McpOAuthTokens): OAuthTokens {
  return {
    access_token: Redacted.value(tokens.accessToken),
    token_type: tokens.tokenType,
    ...(tokens.refreshToken === undefined ? {} : { refresh_token: Redacted.value(tokens.refreshToken) }),
    ...(tokens.expiresAt === undefined ? {} : {
      expires_in: Math.max(0, Math.floor((tokens.expiresAt - Date.now()) / 1000)),
    }),
    ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
    ...(tokens.issuer === undefined ? {} : { issuer: tokens.issuer }),
  };
}

export function fromSdkTokens(tokens: OAuthTokens): McpOAuthTokens {
  return {
    accessToken: Redacted.make(tokens.access_token),
    tokenType: tokens.token_type,
    ...(tokens.refresh_token === undefined ? {} : { refreshToken: Redacted.make(tokens.refresh_token) }),
    ...(tokens.expires_in === undefined ? {} : { expiresAt: Date.now() + tokens.expires_in * 1000 }),
    ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
    ...(tokens.issuer === undefined ? {} : { issuer: tokens.issuer }),
  };
}

export function toSdkClientInformation(info: McpOAuthClientInformation): OAuthClientInformationMixed {
  return {
    client_id: info.clientId,
    ...(info.clientSecret === undefined ? {} : { client_secret: Redacted.value(info.clientSecret) }),
    ...(info.clientIdIssuedAt === undefined ? {} : { client_id_issued_at: info.clientIdIssuedAt }),
    ...(info.clientSecretExpiresAt === undefined ? {} : { client_secret_expires_at: info.clientSecretExpiresAt }),
    ...(info.issuer === undefined ? {} : { issuer: info.issuer }),
  };
}

export function fromSdkClientInformation(info: OAuthClientInformationMixed): McpOAuthClientInformation {
  return {
    clientId: info.client_id,
    ...(info.client_secret === undefined ? {} : { clientSecret: Redacted.make(info.client_secret) }),
    ...(info.client_id_issued_at === undefined ? {} : { clientIdIssuedAt: info.client_id_issued_at }),
    ...(info.client_secret_expires_at === undefined ? {} : { clientSecretExpiresAt: info.client_secret_expires_at }),
    ...(info.issuer === undefined ? {} : { issuer: info.issuer }),
  };
}

function collectSecrets(credential: McpCredential, target: Redacted.Redacted<string>[]): void {
  for (const secret of [
    credential.tokens?.accessToken,
    credential.tokens?.refreshToken,
    credential.clientInformation?.clientSecret,
    credential.codeVerifier,
  ]) {
    if (secret !== undefined && !target.some((known) => Redacted.value(known) === Redacted.value(secret))) target.push(secret);
  }
}

function createCallbackServer(
  state: string,
  resolve: (code: string) => void,
  reject: (error: Error) => void,
): Server {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      response.writeHead(404).end("Not found");
      return;
    }
    const oauthError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    if (oauthError !== null) {
      reject(new Error(oauthError));
      response.writeHead(400, { "Content-Type": "text/plain" }).end("Authorization failed. Return to Flywheel.");
      return;
    }
    if (url.searchParams.get("state") !== state) {
      reject(new Error("OAuth state mismatch"));
      response.writeHead(400, { "Content-Type": "text/plain" }).end("Authorization failed. Return to Flywheel.");
      return;
    }
    const code = url.searchParams.get("code");
    if (code === null) {
      reject(new Error("Missing authorization code"));
      response.writeHead(400, { "Content-Type": "text/plain" }).end("Authorization failed. Return to Flywheel.");
      return;
    }
    resolve(code);
    response.writeHead(200, { "Content-Type": "text/plain" }).end("Authorization complete. Return to Flywheel.");
  });
}

async function listen(server: Server, port: number | undefined): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Could not determine MCP OAuth callback port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}
