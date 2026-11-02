import type { SurfacePlace } from "../protocol/command-catalog-protocol-types.js"

export type SettingsDestination =
  | { readonly kind: "root" }
  | { readonly kind: "models" }
  | { readonly kind: "auth" }
  | { readonly kind: "auth-provider"; readonly providerId: string }
  | {
    readonly kind: "auth-account"
    readonly providerId: string
    readonly accountCorrelationId: string
    readonly envelopeId?: string
  }

/** Where this terminal opens a place inside Settings that a command names. */
export function settingsPlace(place: SurfacePlace): SettingsDestination {
  switch (place) {
    case "authentication": return { kind: "auth" }
  }
}

export type OpenSettingsDestination = (destination: SettingsDestination) => Promise<void>
