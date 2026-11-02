const PROVIDER_ID_MAX_LENGTH = 64;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export class ProviderIdConversionError extends Error {
  override readonly name = "ProviderIdConversionError";
}

function digest(rawId: string): string {
  return new Bun.CryptoHasher("sha256").update(rawId).digest("hex").slice(0, 16);
}

function safeStem(rawId: string): string {
  return rawId.replace(/[^A-Za-z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

function foreignId(prefix: string, rawId: string): string {
  const suffix = digest(rawId);
  const available = PROVIDER_ID_MAX_LENGTH - prefix.length - suffix.length - 1;
  const stem = safeStem(rawId).slice(0, Math.max(0, available));
  return `${prefix}${stem ? `${stem}_` : ""}${suffix}`;
}

export interface CanonicalProviderIds {
  callId: string;
  itemId: string;
  wireKind: "custom" | "function";
}

/** Normalizes one conversation's provider identities. Native valid IDs remain unchanged. Foreign IDs include a digest of all raw bytes, so sanitization and truncation cannot merge distinct calls. */
export class ProviderIdNormalizer {
  private readonly mapped = new Map<string, CanonicalProviderIds>();
  private readonly claimedCallIds = new Map<string, string>();
  private readonly claimedItemIds = new Map<string, string>();

  normalize(rawCallId: string, rawItemId: string | undefined, native: boolean, presentedWireKind: "custom" | "function" = "function"): CanonicalProviderIds {
    const wireKind = native && rawItemId?.startsWith("ctc_")
      ? "custom"
      : native && rawItemId?.startsWith("fc_")
        ? "function"
        : presentedWireKind;
    const mappingKey = `${rawCallId}\0${rawItemId ?? ""}\0${native}\0${wireKind}`;
    const existing = this.mapped.get(mappingKey);
    if (existing) return existing;

    const callId = native && PROVIDER_ID_PATTERN.test(rawCallId) && rawCallId.length <= PROVIDER_ID_MAX_LENGTH
      ? rawCallId
      : foreignId("call_", rawCallId);
    const itemSource = native ? rawItemId ?? rawCallId : rawCallId;
    const itemId = native && rawItemId !== undefined && PROVIDER_ID_PATTERN.test(rawItemId) && rawItemId.length <= PROVIDER_ID_MAX_LENGTH
      ? rawItemId
      : foreignId(wireKind === "custom" ? "ctc_" : "fc_", itemSource);
    const claimedRawId = this.claimedCallIds.get(callId);
    if (claimedRawId !== undefined && claimedRawId !== rawCallId) {
      throw new ProviderIdConversionError(`provider call ID collision after normalization: ${callId}`);
    }
    this.claimedCallIds.set(callId, rawCallId);
    const claimedItemSource = this.claimedItemIds.get(itemId);
    if (claimedItemSource !== undefined && claimedItemSource !== itemSource) {
      throw new ProviderIdConversionError(`provider item ID collision after normalization: ${itemId}`);
    }
    this.claimedItemIds.set(itemId, itemSource);
    const ids = { callId, itemId, wireKind };
    this.mapped.set(mappingKey, ids);
    return ids;
  }
}

export function deterministicMessageId(seed: string): string {
  return `msg_${digest(seed)}`;
}
