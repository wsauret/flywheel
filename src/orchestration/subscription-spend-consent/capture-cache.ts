import type { SubscriptionSpendConsentRevision } from "../../infra/auth/subscription-spend-consent-store.js";

interface CaptureRequest<TCapture extends object> {
  readonly profileDirectory: string
  readonly accountGeneration: () => object | undefined
  readonly readRevision: () => SubscriptionSpendConsentRevision
  readonly lockedCapture: () => Promise<TCapture>
}

interface CachedCapture<TCapture extends object> {
  readonly digest: string
  readonly accounts: object
  readonly capture: Readonly<TCapture>
}

interface InFlightCapture<TCapture extends object> {
  readonly digest: string
  readonly accounts: object
  readonly token: object
  readonly capture: Promise<Readonly<TCapture>>
}

export interface SubscriptionSpendConsentCaptureCache<TCapture extends object> {
  capture(request: CaptureRequest<TCapture>): Promise<Readonly<TCapture>>
  invalidate(profileDirectory: string): void
  clear(): void
}

/** Caches immutable permissions while verified account identities and the consent authority remain unchanged. */
export function createSubscriptionSpendConsentCaptureCache<TCapture extends object>(): SubscriptionSpendConsentCaptureCache<TCapture> {
  const captures = new Map<string, CachedCapture<TCapture>>();
  const inFlight = new Map<string, InFlightCapture<TCapture>>();

  const readRevision = (profileDirectory: string, reader: () => SubscriptionSpendConsentRevision): SubscriptionSpendConsentRevision => {
    try {
      return reader();
    } catch (error) {
      captures.delete(profileDirectory);
      throw error;
    }
  };

  return {
    async capture(request): Promise<Readonly<TCapture>> {
      const accounts = request.accountGeneration();
      const revision = readRevision(request.profileDirectory, request.readRevision);
      const cached = captures.get(request.profileDirectory);
      if (accounts !== undefined && revision.kind === "content" && cached?.accounts === accounts && cached.digest === revision.digest) {
        const confirmed = readRevision(request.profileDirectory, request.readRevision);
        if (confirmed.kind === "content" && confirmed.digest === revision.digest && request.accountGeneration() === accounts) return cached.capture;
      }

      if (accounts !== undefined && revision.kind === "content") {
        const pending = inFlight.get(request.profileDirectory);
        if (pending?.accounts === accounts && pending.digest === revision.digest) return pending.capture;
      }

      const token = {};
      // The locked read is this request's authorization linearization point. A later
      // mutation is concurrent; confirmation controls reuse only. A caller that
      // starts after that mutation reads the new digest and cannot join this entry.
      const operation = (async (): Promise<Readonly<TCapture>> => {
        const capture = Object.freeze(await request.lockedCapture());
        const confirmed = readRevision(request.profileDirectory, request.readRevision);
        if (accounts !== undefined && request.accountGeneration() === accounts && revision.kind === "content" && confirmed.kind === "content" && confirmed.digest === revision.digest && inFlight.get(request.profileDirectory)?.token === token) {
          captures.set(request.profileDirectory, { digest: revision.digest, accounts, capture });
        } else {
          captures.delete(request.profileDirectory);
        }
        return capture;
      })();
      if (accounts !== undefined && revision.kind === "content") {
        inFlight.set(request.profileDirectory, { digest: revision.digest, accounts, token, capture: operation });
      }
      try {
        return await operation;
      } finally {
        if (inFlight.get(request.profileDirectory)?.capture === operation) inFlight.delete(request.profileDirectory);
      }
    },
    invalidate(profileDirectory): void {
      captures.delete(profileDirectory);
      inFlight.delete(profileDirectory);
    },
    clear(): void {
      captures.clear();
      inFlight.clear();
    },
  };
}
