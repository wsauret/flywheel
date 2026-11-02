import { createHash } from "node:crypto";
import { recordCanonicalModelCollisions, recordUnresolvedModelRelationships, type CatalogDiscovery, type CatalogSourceRow, type ResolvedModelCatalog } from "./model-catalog-resolution.js";
import type { CatalogDataUse } from "./model-id.js";
import { Log } from "../log.js";

const MAX_DIAGNOSTIC_SAMPLES = 64;
const DIGEST_MODULUS = 1n << 256n;
const log = Log.create({ service: "model-listing" });

/** Record an HTTP failure and the catalog that actually served the account; no request or response bytes cross this diagnostic boundary. */
export function recordProviderCatalogFailure(providerId: string, discovery: CatalogDiscovery, outcome: ResolvedModelCatalog): void {
  if (!("status" in discovery) || discovery.status === undefined) return;
  log.warn("provider model catalog request failed", {
    providerId,
    status: discovery.status,
    outcome: outcome.kind,
    ...(outcome.kind === "catalog" ? { provenance: outcome.provenance } : { reason: outcome.reason }),
  });
}

export interface CatalogSemanticDigest {
  readonly count: number;
  readonly sum: string;
  readonly xor: string;
}

interface CatalogDiagnosticSamples<T> {
  readonly total: number;
  readonly values: readonly T[];
  readonly digest: CatalogSemanticDigest;
}

export interface CatalogCollisionSample {
  readonly modelId: string;
  readonly dataUse: CatalogDataUse;
  readonly wireModelIds: readonly string[];
  readonly total: number;
}

export interface CatalogDiscoveryDiagnostics {
  readonly baselineGeneration: string;
  readonly unknownWireModelIds: CatalogDiagnosticSamples<string>;
  readonly collisions: CatalogDiagnosticSamples<CatalogCollisionSample>;
}

export class CatalogSemanticDigestAccumulator {
  private count = 0;
  private sum = 0n;
  private xor = 0n;

  add(value: string): void {
    const hash = BigInt(`0x${createHash("sha256").update(value).digest("hex")}`);
    this.count += 1;
    this.sum = (this.sum + hash) % DIGEST_MODULUS;
    this.xor ^= hash;
  }

  merge(digest: CatalogSemanticDigest): void {
    this.count += digest.count;
    this.sum = (this.sum + BigInt(`0x${digest.sum}`)) % DIGEST_MODULUS;
    this.xor ^= BigInt(`0x${digest.xor}`);
  }

  snapshot(): CatalogSemanticDigest {
    return {
      count: this.count,
      sum: this.sum.toString(16).padStart(64, "0"),
      xor: this.xor.toString(16).padStart(64, "0"),
    };
  }
}

export class CatalogDiscoveryDiagnosticAccumulator {
  private readonly unknownDigest = new CatalogSemanticDigestAccumulator();
  private readonly unknownWireModelIds: string[] = [];
  private unknownTotal = 0;
  private readonly wireIdsByIdentity = new Map<string, Set<string>>();

  constructor(private readonly modelIdLength: number) {}

  addUnknown(wireModelId: string): void {
    this.unknownTotal += 1;
    this.unknownDigest.add(wireModelId);
    if (diagnosticIdIsSafe(wireModelId, this.modelIdLength)) {
      retainDiagnosticSample(this.unknownWireModelIds, wireModelId, (value) => value);
    }
  }

  addResolved(row: CatalogSourceRow): void {
    const identity = `${row.modelId}\0${row.dataUse ?? "standard"}`;
    const wireIds = this.wireIdsByIdentity.get(identity) ?? new Set<string>();
    wireIds.add(row.wireModelId);
    this.wireIdsByIdentity.set(identity, wireIds);
  }

  snapshot(): Pick<CatalogDiscoveryDiagnostics, "unknownWireModelIds" | "collisions"> {
    const collisionDigest = new CatalogSemanticDigestAccumulator();
    const collisionCandidates: CatalogCollisionSample[] = [];
    let collisionTotal = 0;
    for (const [identity, wireIds] of this.wireIdsByIdentity) {
      if (wireIds.size < 2) continue;
      const separator = identity.indexOf("\0");
      const modelId = identity.slice(0, separator);
      const dataUse = catalogDataUse(identity.slice(separator + 1));
      const sortedWireIds = [...wireIds].toSorted();
      for (const wireModelId of sortedWireIds) collisionDigest.add(`${identity}\0${wireModelId}`);
      collisionTotal += 1;
      const safeWireIds = sortedWireIds.filter((wireModelId) => diagnosticIdIsSafe(wireModelId, this.modelIdLength));
      if (diagnosticIdIsSafe(modelId, this.modelIdLength) && safeWireIds.length > 0) {
        retainDiagnosticSample(collisionCandidates, {
          modelId,
          dataUse,
          wireModelIds: safeWireIds.slice(0, MAX_DIAGNOSTIC_SAMPLES),
          total: wireIds.size,
        }, (collision) => `${collision.total < 2 ? "1" : "0"}\0${collisionKey(collision)}`);
      }
    }
    return {
      unknownWireModelIds: {
        total: this.unknownTotal,
        values: this.unknownWireModelIds,
        digest: this.unknownDigest.snapshot(),
      },
      collisions: {
        total: collisionTotal,
        values: collisionCandidates,
        digest: collisionDigest.snapshot(),
      },
    };
  }
}

/** Retains the lexicographically smallest bounded sample, independent of arrival order. */
function retainDiagnosticSample<T>(
  values: T[],
  value: T,
  key: (value: T) => string,
  limit = MAX_DIAGNOSTIC_SAMPLES,
): void {
  const valueKey = key(value);
  if (values.some((entry) => key(entry) === valueKey)) return;
  const index = values.findIndex((entry) => compareStrings(key(entry), valueKey) > 0);
  values.splice(index === -1 ? values.length : index, 0, value);
  if (values.length > limit) values.pop();
}

/** Emits each provider discovery diagnostic when its latest complete observation changes. */
export function recordCatalogDiscoveryDiagnostics(
  latest: Map<string, string>,
  observations: readonly { readonly providerId: string; readonly diagnostics?: CatalogDiscoveryDiagnostics }[],
): void {
  const byProvider = new Map<string, {
    baselineGenerations: string[];
    unknownTotal: number;
    unknownDigest: CatalogSemanticDigestAccumulator;
    unknownWireModelIds: string[];
    collisionTotal: number;
    collisionDigest: CatalogSemanticDigestAccumulator;
    collisionCandidates: Map<string, { total: number; wireModelIds: string[] }>;
  }>();
  for (const { providerId, diagnostics } of observations) {
    if (diagnostics === undefined) continue;
    const aggregate = byProvider.get(providerId) ?? {
      baselineGenerations: [],
      unknownTotal: 0,
      unknownDigest: new CatalogSemanticDigestAccumulator(),
      unknownWireModelIds: [],
      collisionTotal: 0,
      collisionDigest: new CatalogSemanticDigestAccumulator(),
      collisionCandidates: new Map(),
    };
    retainDiagnosticSample(aggregate.baselineGenerations, diagnostics.baselineGeneration, (value) => value);
    aggregate.unknownTotal += diagnostics.unknownWireModelIds.total;
    aggregate.unknownDigest.merge(diagnostics.unknownWireModelIds.digest);
    for (const wireModelId of diagnostics.unknownWireModelIds.values) {
      retainDiagnosticSample(aggregate.unknownWireModelIds, wireModelId, (value) => value);
    }
    aggregate.collisionTotal += diagnostics.collisions.total;
    aggregate.collisionDigest.merge(diagnostics.collisions.digest);
    for (const collision of diagnostics.collisions.values) {
      const identity = `${collision.modelId}\0${collision.dataUse}`;
      retainCollisionCandidate(aggregate.collisionCandidates, identity, collision);
    }
    byProvider.set(providerId, aggregate);
  }
  for (const [providerId, diagnostics] of byProvider) {
    const baseline = diagnostics.baselineGenerations.join("\0");
    recordLatest(latest, "unresolved", providerId, baseline, diagnostics.unknownTotal, diagnostics.unknownDigest.snapshot(), () => {
      recordUnresolvedModelRelationships(providerId, {
        total: diagnostics.unknownTotal,
        values: diagnostics.unknownWireModelIds,
      });
    });
    const collisionSamples: CatalogCollisionSample[] = [];
    for (const [identity, collision] of diagnostics.collisionCandidates) {
      const separator = identity.indexOf("\0");
      retainDiagnosticSample(collisionSamples, {
        modelId: identity.slice(0, separator),
        dataUse: catalogDataUse(identity.slice(separator + 1)),
        wireModelIds: collision.wireModelIds,
        total: collision.total,
      }, collisionKey);
    }
    recordLatest(latest, "collisions", providerId, baseline, diagnostics.collisionTotal, diagnostics.collisionDigest.snapshot(), () => {
      recordCanonicalModelCollisions(providerId, {
        total: diagnostics.collisionTotal,
        values: collisionSamples,
      });
    });
  }
}

function recordLatest(
  latest: Map<string, string>,
  family: string,
  providerId: string,
  baselineGeneration: string,
  total: number,
  digest: CatalogSemanticDigest,
  record: () => void,
): void {
  const key = `${family}\0${providerId}`;
  const observation = `${baselineGeneration}\0${total}\0${digest.count}\0${digest.sum}\0${digest.xor}`;
  if (latest.get(key) === observation) return;
  latest.set(key, observation);
  if (total === 0) return;
  record();
}

function collisionKey(collision: CatalogCollisionSample): string {
  return `${collision.modelId}\0${collision.dataUse}\0${collision.wireModelIds.join("\0")}`;
}

function diagnosticIdIsSafe(value: string, maxLength: number): boolean {
  if (value.length > maxLength) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1F || codePoint >= 0x7F && codePoint <= 0x9F) return false;
  }
  return true;
}

function catalogDataUse(value: string): CatalogDataUse {
  return value === "contributor" ? "contributor" : "standard";
}

function retainCollisionCandidate(
  candidates: Map<string, { total: number; wireModelIds: string[] }>,
  identity: string,
  collision: CatalogCollisionSample,
): void {
  const existing = candidates.get(identity);
  if (existing !== undefined) {
    existing.total += collision.total;
    for (const wireModelId of collision.wireModelIds) {
      retainDiagnosticSample(existing.wireModelIds, wireModelId, (value) => value);
    }
  } else {
    candidates.set(identity, {
      total: collision.total,
      wireModelIds: collision.wireModelIds.slice(0, MAX_DIAGNOSTIC_SAMPLES),
    });
  }
  if (candidates.size <= MAX_DIAGNOSTIC_SAMPLES) return;
  const worst = [...candidates].toSorted(([leftIdentity], [rightIdentity]) => compareStrings(rightIdentity, leftIdentity))[0];
  if (worst !== undefined) candidates.delete(worst[0]);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
