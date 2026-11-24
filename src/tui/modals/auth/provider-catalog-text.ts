import type { ProviderCatalogDiscovery } from "../../../protocol/provider-model-preference-protocol-types.js"

function providerCatalogSourceLabel(provenance: Extract<ProviderCatalogDiscovery, { readonly kind: "available" }>["provenance"]): string {
  if (provenance === "first-party") return ""
  if (provenance === "first-party-cached") return "Provider (cached)"
  if (provenance === "models-dev-live") return "Models.dev (current)"
  if (provenance === "models-dev-archive") return "Models.dev (cached)"
  if (provenance === "models-dev-bundled") return "Models.dev (bundled)"
  return "Static"
}

function unavailableCatalogStatus(reason: Extract<ProviderCatalogDiscovery, { readonly kind: "unavailable" }>["reason"]): string {
  if (reason === "empty") return "Provider list empty"
  if (reason === "unusable") return "Provider list unreadable"
  if (reason === "authentication-invalid") return "Authentication invalid"
  if (reason === "authentication-absent") return "Provider list unavailable · authentication absent"
  if (reason === "discovery-pending") return "Discovering provider list"
  return "Provider list unavailable"
}

export function providerCatalogStatusText(catalog: ProviderCatalogDiscovery): string | undefined {
  if (catalog.kind === "unavailable") {
    return [unavailableCatalogStatus(catalog.reason), discoveryFailureText(catalog.discoveryReason)].filter(Boolean).join(" · ")
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
