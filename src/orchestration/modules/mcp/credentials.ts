import { createHash } from "node:crypto";
import { Redacted, Schema } from "effect";
import {
  lockedJsonStorePath,
  MalformedLockedJsonError,
  mutateLockedJsonStore,
  readLockedJsonStore,
  type LockedJsonStoreOptions,
} from "../../../infra/auth/locked-json-store.js";
import { accountSecretFile } from "../../../infra/paths.js";

const DiskTokensSchema = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  expires_at: Schema.optionalKey(Schema.Number),
  scope: Schema.optionalKey(Schema.String),
  issuer: Schema.optionalKey(Schema.String),
});

const DiskClientInformationSchema = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.optionalKey(Schema.String),
  client_id_issued_at: Schema.optionalKey(Schema.Number),
  client_secret_expires_at: Schema.optionalKey(Schema.Number),
  issuer: Schema.optionalKey(Schema.String),
});

const DiskCredentialSchema = Schema.Struct({
  tokens: Schema.optionalKey(DiskTokensSchema),
  client_information: Schema.optionalKey(DiskClientInformationSchema),
  code_verifier: Schema.optionalKey(Schema.String),
  client_secret: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const DiskCredentialStoreSchema = Schema.Record(Schema.String, DiskCredentialSchema);

type DiskCredential = typeof DiskCredentialSchema.Type;
type DiskCredentialStore = { [K in string]: DiskCredential };

export interface McpOAuthTokens {
  readonly accessToken: Redacted.Redacted<string>;
  readonly tokenType: string;
  readonly refreshToken?: Redacted.Redacted<string>;
  readonly expiresAt?: number;
  readonly scope?: string;
  /** Authorization server that issued the tokens. The MCP SDK never presents a refresh
   *  token to another server. Entries stored before 2026-10-29 have no issuer; the SDK
   *  uses them once and stamps the issuer on the tokens it saves next. */
  readonly issuer?: string;
}

export interface McpOAuthClientInformation {
  readonly clientId: string;
  readonly clientSecret?: Redacted.Redacted<string>;
  readonly clientIdIssuedAt?: number;
  readonly clientSecretExpiresAt?: number;
  /** Authorization server that registered the client. Entries stored before 2026-10-29
   *  have no issuer; the SDK binds them to the first server that accepts them. A release
   *  from before 2026-10-29 reads the store strictly, so after a rollback to such a release
   *  a store that holds an issuer is refused until it is moved, which costs a new login to
   *  each MCP server. */
  readonly issuer?: string;
}

type McpSecretHeaders = { readonly [K in string]: Redacted.Redacted<string> };

export interface McpCredential {
  readonly tokens?: McpOAuthTokens;
  readonly clientInformation?: McpOAuthClientInformation;
  readonly codeVerifier?: Redacted.Redacted<string>;
  /** Secret of the pre-registered OAuth client that the server's `oauth.client_id`
   *  names. It is kept apart from `clientInformation`, which holds only what dynamic
   *  registration issued, so a reset of the registered client cannot erase it. */
  readonly clientSecret?: Redacted.Redacted<string>;
  /** Static secret headers diverted out of flywheel.toml (e.g. literal API keys pasted from vendor docs). */
  readonly headers?: McpSecretHeaders;
}

export interface McpCredentialStore {
  get(server: string, url: string): McpCredential | undefined;
  save(server: string, url: string, credential: McpCredential): Promise<void>;
  delete(server: string, url: string): Promise<void>;
}

export function credentialKey(server: string, url: string): string {
  return `${server}:${createHash("sha256").update(url).digest("hex")}`;
}

export function fromDiskCredential(value: DiskCredential): McpCredential {
  return {
    ...(value.tokens === undefined ? {} : {
      tokens: {
        accessToken: Redacted.make(value.tokens.access_token),
        tokenType: value.tokens.token_type,
        ...(value.tokens.refresh_token === undefined ? {} : { refreshToken: Redacted.make(value.tokens.refresh_token) }),
        ...(value.tokens.expires_at === undefined ? {} : { expiresAt: value.tokens.expires_at }),
        ...(value.tokens.scope === undefined ? {} : { scope: value.tokens.scope }),
        ...(value.tokens.issuer === undefined ? {} : { issuer: value.tokens.issuer }),
      },
    }),
    ...(value.client_information === undefined ? {} : {
      clientInformation: {
        clientId: value.client_information.client_id,
        ...(value.client_information.client_secret === undefined
          ? {}
          : { clientSecret: Redacted.make(value.client_information.client_secret) }),
        ...(value.client_information.client_id_issued_at === undefined
          ? {}
          : { clientIdIssuedAt: value.client_information.client_id_issued_at }),
        ...(value.client_information.client_secret_expires_at === undefined
          ? {}
          : { clientSecretExpiresAt: value.client_information.client_secret_expires_at }),
        ...(value.client_information.issuer === undefined ? {} : { issuer: value.client_information.issuer }),
      },
    }),
    ...(value.code_verifier === undefined ? {} : { codeVerifier: Redacted.make(value.code_verifier) }),
    ...(value.client_secret === undefined ? {} : { clientSecret: Redacted.make(value.client_secret) }),
    ...(value.headers === undefined ? {} : {
      headers: Object.fromEntries(Object.entries(value.headers).map(([name, header]) => [name, Redacted.make(header)])),
    }),
  };
}

export function toDiskCredential(value: McpCredential): DiskCredential {
  return {
    ...(value.tokens === undefined ? {} : {
      tokens: {
        access_token: Redacted.value(value.tokens.accessToken),
        token_type: value.tokens.tokenType,
        ...(value.tokens.refreshToken === undefined ? {} : { refresh_token: Redacted.value(value.tokens.refreshToken) }),
        ...(value.tokens.expiresAt === undefined ? {} : { expires_at: value.tokens.expiresAt }),
        ...(value.tokens.scope === undefined ? {} : { scope: value.tokens.scope }),
        ...(value.tokens.issuer === undefined ? {} : { issuer: value.tokens.issuer }),
      },
    }),
    ...(value.clientInformation === undefined ? {} : {
      client_information: {
        client_id: value.clientInformation.clientId,
        ...(value.clientInformation.clientSecret === undefined
          ? {}
          : { client_secret: Redacted.value(value.clientInformation.clientSecret) }),
        ...(value.clientInformation.clientIdIssuedAt === undefined
          ? {}
          : { client_id_issued_at: value.clientInformation.clientIdIssuedAt }),
        ...(value.clientInformation.clientSecretExpiresAt === undefined
          ? {}
          : { client_secret_expires_at: value.clientInformation.clientSecretExpiresAt }),
        ...(value.clientInformation.issuer === undefined ? {} : { issuer: value.clientInformation.issuer }),
      },
    }),
    ...(value.codeVerifier === undefined ? {} : { code_verifier: Redacted.value(value.codeVerifier) }),
    ...(value.clientSecret === undefined ? {} : { client_secret: Redacted.value(value.clientSecret) }),
    ...(value.headers === undefined ? {} : {
      headers: Object.fromEntries(Object.entries(value.headers).map(([name, header]) => [name, Redacted.value(header)])),
    }),
  };
}

export function createMcpCredentialStore(dir: string): McpCredentialStore {
  const location = accountSecretFile(dir, "mcp-credentials.json");
  const options: LockedJsonStoreOptions<DiskCredentialStore> = {
    location,
    empty: () => ({}),
    decode: (value) => ({ ...Schema.decodeUnknownSync(DiskCredentialStoreSchema, { onExcessProperty: "error" })(value) }),
    encode: (value) => value,
  };
  return {
    get(server, url) {
      const state = readLockedJsonStore(options);
      if (state.tag === "malformed") throw malformed(lockedJsonStorePath(location));
      if (state.tag === "absent") return undefined;
      const credential = state.value[credentialKey(server, url)];
      return credential === undefined ? undefined : fromDiskCredential(credential);
    },
    async save(server, url, credential) {
      await mutateLockedJsonStore(options, (store) => {
        store[credentialKey(server, url)] = toDiskCredential(credential);
      });
    },
    async delete(server, url) {
      await mutateLockedJsonStore(options, (store) => {
        Reflect.deleteProperty(store, credentialKey(server, url));
      });
    },
  };
}

function malformed(path: string): MalformedLockedJsonError {
  return new MalformedLockedJsonError({
    path,
    message: `Cannot read malformed credential store at ${path}. Repair or move the file and try again.`,
  });
}
