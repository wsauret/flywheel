import type { ProviderCatalogDiscovery } from "../../protocol/provider-model-preference-protocol-types.js"

function providerCatalogSourceLabel(provenance: Extract<ProviderCatalogDiscovery, { readonly kind: "available" }>["provenance"]): string {
  if (provenance === "first-party") return ""
  if (provenance === "first-party-cached") return "Provider (cached)"
  if (provenance === "models-dev-live") return "Models.dev (current)"
  if (provenance === "models-dev-archive") return "Models.dev (cached)"
  if (provenance === "models-dev-bundled") return "Models.dev (bundled)"
  return "Static"
}

export function providerCatalogStatusText(catalog: ProviderCatalogDiscovery): string | undefined {
  if (catalog.kind === "unavailable") {
    const status = catalog.reason === "empty"
      ? "Provider list empty"
      : catalog.reason === "unusable"
        ? "Provider list unreadable"
        : catalog.reason === "authentication-invalid"
          ? "Authentication invalid"
          : catalog.reason === "authentication-absent"
            ? "Provider list unavailable · authentication absent"
            : catalog.reason === "discovery-pending"
              ? "Discovering provider list"
              : "Provider list unavailable"
    return [status, discoveryFailureText(catalog.discoveryReason)].filter(Boolean).join(" · ")
  }
  const source = providerCatalogSourceLabel(catalog.provenance)
  if (catalog.liveOutcome === "valid") return source || undefined
  const outcome = catalog.liveOutcome === "empty"
    ? "provider list empty"
    : catalog.liveOutcome === "unusable"
      ? "provider list unreadable"
      : catalog.liveOutcome === "authentication-invalid"
        ? "provider list unavailable · authentication invalid"
        : "provider list unavailable"
  return [source, outcome].filter(Boolean).join(" · ")
}

function discoveryFailureText(reason: Extract<ProviderCatalogDiscovery, { readonly kind: "unavailable" }>["discoveryReason"]): string | undefined {
  if (reason === "timeout") return "Discovery timed out"
  if (reason === "oversized") return "Response was too large"
  if (reason === "malformed") return "Response was unreadable"
  if (reason === "transport") return "Could not reach provider"
  if (reason === "http") return "Provider request failed"
  return undefined
}

export function providerCatalogRequiresReconnect(catalog: ProviderCatalogDiscovery | undefined): boolean {
  return catalog?.kind === "unavailable"
    ? catalog.reason === "authentication-invalid"
    : catalog?.liveOutcome === "authentication-invalid"
}
