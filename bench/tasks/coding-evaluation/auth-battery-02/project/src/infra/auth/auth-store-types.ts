import { Schema } from "effect";
import { createInstalledIdSchema } from "../literal-schema.js";

const boundedString = (maxLength: number) => Schema.String.pipe(Schema.refine((value): value is string => value.length > 0 && value.length <= maxLength, { message: `expected 1-${maxLength} characters` }));
const ApiSecretSchema = boundedString(64 * 1024);
const OAuthTokenSchema = boundedString(8 * 1024);
const AccountIdSchema = boundedString(1024);
const EnterpriseDomainSchema = boundedString(253);
const InstanceIdSchema = boundedString(1024);
const IdentitySchema = boundedString(1024);
const LabelSchema = boundedString(256);
const ExpirySchema = Schema.Number.pipe(Schema.refine((value): value is number => Number.isSafeInteger(value) && value > 0 && value <= 32_503_680_000_000, { message: "expected a valid expiry timestamp" }));
const LineageIdSchema = Schema.String.pipe(Schema.refine(
  (value): value is string => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
  { message: "expected a UUID credential lineage" },
));

const ApiKeyCredentialFields = {
  type: Schema.Literal("api_key"),
  key: ApiSecretSchema,
};
const ApiKeyCredentialSchema = Schema.Struct(ApiKeyCredentialFields);

const OAuthCredentialFields = {
  type: Schema.Literal("oauth"),
  access: OAuthTokenSchema,
  // Absent when the provider issued no refresh token (ChatGPT's refresh_token
  // is optional on the wire). Copilot always writes it; its reader throws.
  refresh: Schema.optionalKey(OAuthTokenSchema),
  expires: ExpirySchema,
  accountId: Schema.optionalKey(AccountIdSchema),
  enterpriseDomain: Schema.optionalKey(EnterpriseDomainSchema),
};
const OAuthCredentialSchema = Schema.Struct(OAuthCredentialFields);

export const CredentialSchema = Schema.Union([
  ApiKeyCredentialSchema,
  OAuthCredentialSchema,
]);

export const CredentialInstanceSchema = Schema.Struct({
  id: InstanceIdSchema,
  identity: IdentitySchema,
  label: Schema.optionalKey(LabelSchema),
  lineageId: Schema.optionalKey(LineageIdSchema),
  credential: CredentialSchema,
});

export const PersistentCredentialInstanceSchema = Schema.Struct({
  id: InstanceIdSchema,
  identity: IdentitySchema,
  label: Schema.optionalKey(LabelSchema),
  lineageId: LineageIdSchema,
  credential: CredentialSchema,
});

const CredentialLineagesSchema = Schema.Record(Schema.String, LineageIdSchema);
export type CredentialLineages = typeof CredentialLineagesSchema.Type;

export const MeteredCredentialRecordSchema = Schema.Union([
  Schema.Struct({ ...ApiKeyCredentialFields, lineageId: LineageIdSchema }),
  Schema.Struct({ ...OAuthCredentialFields, lineageId: LineageIdSchema }),
]);

export const NestedMeteredCredentialRecordSchema = Schema.Struct({
  lineageId: LineageIdSchema,
  credential: CredentialSchema,
});

const CredentialCollectionSchema = Schema.Array(CredentialInstanceSchema).pipe(Schema.refine(
  (value): value is typeof value => new Set(value.map(({ id }) => id)).size === value.length,
  { message: "credential instance IDs must be unique within a provider" },
));

export type OAuthCredential = typeof OAuthCredentialSchema.Type;
export type Credential = typeof CredentialSchema.Type;
export type CredentialInstance = typeof CredentialInstanceSchema.Type;
export type CredentialCollection = typeof CredentialCollectionSchema.Type;

export function isCredentialCollection(value: Credential | CredentialCollection | undefined): value is CredentialCollection {
  return Array.isArray(value);
}
export type CredentialSlot = "subscription" | "metered";
export type CredentialSlotClassifier = (providerId: CredentialProviderId) => CredentialSlot;

/** Builds the persisted auth-store schema from the installed credential catalog. */
export function createAuthStoreSchema<const Id extends string>(installedIds: readonly Id[]) {
  return Schema.Record(createInstalledIdSchema(installedIds), Schema.Union([MeteredCredentialRecordSchema, CredentialCollectionSchema]));
}

export const PersistedAuthStoreSchema = Schema.Record(Schema.String, Schema.Union([MeteredCredentialRecordSchema, CredentialCollectionSchema]));

/** Credential identities are open inside infra. Real boundaries inject the installed catalog. */
export type CredentialProviderId = string;
export interface AuthStore { [providerId: string]: Credential | CredentialCollection }
export type PersistedAuthStore = typeof PersistedAuthStoreSchema.Type;
