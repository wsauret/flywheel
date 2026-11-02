/** Fixtures shared by the provider-availability suites: the process-local
 *  folds in `provider-availability.test.ts`, the account-scoped durable
 *  coordination in `provider-availability-authority.test.ts`, and the
 *  service-row outage coordination in `provider-availability-outage.test.ts`. */

import { afterEach } from "bun:test";
import { Redacted } from "effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AccessProviderCandidate, AccessProviderId } from "../../../../../src/infra/llm/access-provider.js";
import { createAvailabilityAuthority, type AvailabilityAuthority } from "../../../../../src/infra/llm/availability-store.js";
import { createProviderAvailability } from "../../../../../src/orchestration/agent-runtime/llm/provider-availability.js";

interface UnknownRecord {
  [key: string]: unknown;
}

export const auth = { githubToken: Redacted.make("github-token") };
export const query = { auth };
export const credits = (n: number): number => n * 1_000_000_000;

export const singleton = (providerId: AccessProviderId): AccessProviderCandidate => ({ kind: "singleton", providerId, spendMode: "direct_api" });
export const subscription = (providerId: AccessProviderId, instanceId: string): AccessProviderCandidate => ({ kind: "subscription", providerId, instanceId, spendMode: "included" });
export const OPENAI_API = singleton("openai_api");
export const OPENROUTER = singleton("openrouter");
export const GOOGLE_API = singleton("google_api");
export const COPILOT = subscription("github_copilot", "copilot-account");
export const CHATGPT = subscription("chatgpt", "chatgpt-account");

const DEFAULT_CANDIDATES = [OPENAI_API, OPENROUTER, GOOGLE_API, COPILOT, CHATGPT];

/** The harness clock starts here, so a test states its moments around it. */
export const NOW_MS = 1_000_000;

/** Mirrors `SAFE_RECHECK_MS` in the owner: how long a suppression with no
 *  provider-reported reset holds before one request may check again. */
export const SAFE_RECHECK_MS = 5 * 60_000;

/** Mirrors `OUTAGE_HOLD_MS` in the owner: how long a first outage mark holds. */
export const OUTAGE_HOLD_MS = 60_000;

/** Mirrors `OUTAGE_MEMORY_MS` in the owner: how long after an expired hold a
 *  new mark still counts as the same outage. */
export const OUTAGE_MEMORY_MS = 15 * 60_000;

/** Mirrors `METER_LEASE_MS` in the owner: how long one owner holds the right
 *  to poll the Copilot meter. */
export const METER_LEASE_MS = 30_000;

export function quotaBody(body: UnknownRecord): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** Enterprise seat: token-based billing states consumption, never a balance. */
export function enterpriseQuota(creditsUsed: number): UnknownRecord {
  return {
    quota_reset_date: "2026-08-01",
    quota_snapshots: {
      premium_interactions: { unlimited: true, token_based_billing: true, credits_used: creditsUsed },
    },
  };
}

/** Every other plan: a metered premium-interaction balance. */
export function seatQuota(remaining: number, entitlement = remaining): UnknownRecord {
  return {
    quota_reset_date: "2026-08-01",
    quota_snapshots: {
      premium_interactions: { unlimited: false, entitlement, remaining, overage_permitted: false },
    },
  };
}

export const ok = (body: UnknownRecord) => async () => quotaBody(body);

/** Fake clock + fetch seam. `responses` is consumed one entry per poll. The
 *  returned view is bound to `candidates`, as one client's chain is. */
export function harness(
  responses: Array<() => Promise<Response>>,
  authority?: AvailabilityAuthority,
  candidates: readonly AccessProviderCandidate[] = authority ? [] : DEFAULT_CANDIDATES,
) {
  const calls: Array<{ url: string; headers: Headers }> = [];
  let nowMs = NOW_MS;
  const owner = createProviderAvailability({
    now: () => nowMs,
    ...(authority ? { authority } : {}),
  });
  return { owner, availability: owner.forCandidates("default", candidates), calls, advance: (ms: number) => { nowMs += ms } };
}

/** Call once in each suite. One teardown owns the handles and their directories,
 *  so file removal cannot precede disposal on Windows. */
export function availabilityFixtures() {
  const directories: string[] = [];
  const authorities: AvailabilityAuthority[] = [];
  afterEach(async () => {
    for (const authority of authorities.splice(0)) await authority.dispose();
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });
  const temporaryDirectory = (prefix: string): string => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    directories.push(directory);
    return directory;
  };
  return {
    temporaryDirectory,
    tempDbFile: () => path.join(temporaryDirectory("flywheel-provider-availability-"), "availability-authority.sqlite"),
    createAuthority: (options: Parameters<typeof createAvailabilityAuthority>[0]) => {
      const authority = createAvailabilityAuthority(options);
      authorities.push(authority);
      return authority;
    },
  };
}
