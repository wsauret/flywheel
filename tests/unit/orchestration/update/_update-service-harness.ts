/** The update service harness that the service coordination tests and the
 *  policy setting tests share: a fake account authority, a fake policy store,
 *  a manual scheduler, and a service built over them. */

import type { UpdateAuthority } from "../../../../src/infra/update/update-authority.js";
import { parseReleaseVersion } from "../../../../src/infra/update/version-order.js";
import type { UpdateCheckResult } from "../../../../src/orchestration/update/update-check.js";
import {
  createUpdateService,
  type UpdateInstaller,
  type UpdatePolicyStore,
  type UpdateServiceDeps,
} from "../../../../src/orchestration/update/update-service.js";
import type { UpdateStatusView } from "../../../../src/protocol/update-protocol-types.js";

export const ASSET = "flywheel-darwin-arm64.tar.gz";

export function candidate(released = "1.3.0"): UpdateCheckResult {
  const version = parseReleaseVersion(released);
  if (!version) throw new Error(`${released} is not a release version`);
  return {
    kind: "candidate",
    release: {
      version,
      asset: { name: ASSET, url: `https://github.com/acme/flywheel/releases/download/v${released}/${ASSET}`, sizeBytes: 1024, sha256: "a".repeat(64) },
    },
  };
}

export interface PendingTimer {
  readonly fire: () => void;
  readonly delayMs: number;
  cancelled: boolean;
}

export function testScheduler() {
  const timers: PendingTimer[] = [];
  return {
    timers,
    scheduler: {
      nowMs: () => 1_000,
      setTimer: (fire: () => void, delayMs: number) => {
        const timer: PendingTimer = { fire, delayMs, cancelled: false };
        timers.push(timer);
        return () => { timer.cancelled = true; };
      },
    },
    fireAll: () => {
      // A snapshot, because a timer that fires may arm the next one.
      for (const timer of timers.slice()) if (!timer.cancelled) timer.fire();
    },
  };
}

export interface AuthorityCalls {
  claims: number;
  renews: number;
  committedChecks: number;
  disposals: number;
}

export function fakeAuthority(overrides: Partial<UpdateAuthority> = {}) {
  const calls: AuthorityCalls = { claims: 0, renews: 0, committedChecks: 0, disposals: 0 };
  const authority: UpdateAuthority = {
    claim: () => { calls.claims += 1; return { kind: "won", fence: 7, leaseExpiresAtMs: 61_000 }; },
    renew: () => { calls.renews += 1; return "held"; },
    commitCheck: () => { calls.committedChecks += 1; return true; },
    commitActivation: ({ activate }) => { activate(); return true; },
    dispose: () => { calls.disposals += 1; },
    ...overrides,
  };
  return { authority, calls };
}

/** A policy store whose durable value the test owns. `forcedOff` is the
 *  environment override, which is what makes a durable write land without the
 *  effective policy moving. */
export function fakePolicy(initial: boolean, forcedOff = false): UpdatePolicyStore & { value: boolean; writes: boolean[]; failWrite: boolean } {
  const store: UpdatePolicyStore & { value: boolean; writes: boolean[]; failWrite: boolean } = {
    value: initial,
    writes: [],
    failWrite: false,
    read: () => ({ persisted: store.value, forcedOff, effective: store.value && !forcedOff }),
    revalidate: async (decide) => decide(store.read()),
    write: async (expected: boolean, next: boolean) => {
      store.writes.push(next);
      if (store.failWrite) return { ok: false as const, error: Object.assign(new Error("config is unwritable"), { _tag: "ConfigWriteError" as const }) };
      if (store.value !== expected) return { ok: false as const, error: Object.assign(new Error("stale"), { _tag: "ConfigWriteError" as const }) };
      store.value = next;
      return { ok: true as const };
    },
  };
  return store;
}

/** Every dependency a test overrides. The installer is given as its transfer
 *  half alone, because collection is the half the service drives on its own
 *  schedule: the harness supplies it and counts it, so no test has to repeat a
 *  collector it is not about. */
export type HarnessOverrides = Partial<Omit<UpdateServiceDeps, "installer">> & {
  readonly autoInstall?: boolean;
  readonly forcedOff?: boolean;
  readonly installer?: Pick<UpdateInstaller, "install">;
};

/** What the harness observed about collection: how many times the service
 *  asked for one, a failure a test wants the next one to hit, and the work a
 *  test wants the next one to do with the withdrawal signal it is given. */
export interface CollectionCalls {
  count: number;
  failure?: Error;
  work?: (signal: AbortSignal) => Promise<void>;
}

export function harness(overrides: HarnessOverrides = {}) {
  const { autoInstall = true, forcedOff = false, installer, ...depsOverrides } = overrides;
  const published: UpdateStatusView[] = [];
  const policy = fakePolicy(autoInstall, forcedOff);
  const clock = testScheduler();
  const authority = fakeAuthority();
  const collections: CollectionCalls = { count: 0 };
  const service = createUpdateService({
    currentVersion: "1.2.3",
    platformArch: "darwin-arm64",
    repository: "acme/flywheel",
    policy,
    openAuthority: () => authority.authority,
    scheduler: clock.scheduler,
    publish: (view) => { published.push(view); },
    check: async () => candidate(),
    installer: installer && {
      install: installer.install,
      collect: async (signal) => {
        collections.count += 1;
        if (collections.failure) throw collections.failure;
        await collections.work?.(signal);
      },
    },
    ...depsOverrides,
  });
  return { service, published, policy, clock, authority, collections };
}

export function statuses(published: readonly UpdateStatusView[]): string[] {
  return published.map((view) => view.status.kind);
}

/** An installer that parks until the test releases it, so a run can be
 *  observed while it is installing. */
export function blockingInstaller() {
  let announce: (signal: AbortSignal) => void = () => {};
  const started = new Promise<AbortSignal>((resolve) => { announce = resolve; });
  let settle: (outcome: "installed" | "revoked") => void = () => {};
  const parked = new Promise<"installed" | "revoked">((resolve) => { settle = resolve; });
  return {
    started,
    release: (outcome: "installed" | "revoked" = "installed") => { settle(outcome); },
    installer: {
      install: async (request: Parameters<UpdateInstaller["install"]>[0]) => {
        announce(request.signal);
        const outcome = await parked;
        return { kind: outcome };
      },
    },
  };
}
