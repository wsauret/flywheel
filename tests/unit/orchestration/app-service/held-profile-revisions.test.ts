import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { appendFileSync, chmodSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { AuthProfileStore, openExistingAuthProfileDirectory, type ActiveProfileWatcher, type ActiveProfileWatcherOptions } from "../../../../src/infra/auth/auth-profile-store.js"
import { installCustomProviders } from "../../../../src/infra/llm/custom-provider-registry.js"
import { heldAuthStoreLoad } from "../../../../src/orchestration/app-service/held-auth-store-load.js"
import { authStoreObservedRevision } from "../../../../src/infra/auth/auth-store.js"
import { createSubscriptionSpendConsentStore } from "../../../../src/infra/auth/subscription-spend-consent-store.js"
import { createSubscriptionSpendEnvelope } from "../../../../src/infra/auth/subscription-spend-consent.js"
import { createSubscriptionAccountIdentity } from "../../../../src/infra/llm/subscription-account-identity.js"
import { ContainedDirectory } from "../../../../src/infra/descriptor-directory.js"
import { authDir } from "../../../../src/infra/paths.js"
import { authProfileEligibilityInputRevision } from "../../../../src/orchestration/app-service/eligibility-preparation.js"
import { createSubscriptionUsageServicePool } from "../../../../src/orchestration/auth/provider-observations/subscription-usage-service-pool.js"
import { createSubscriptionUsageService } from "../../../../src/orchestration/auth/provider-observations/subscription-usage-service.js"
import { captureSubscriptionAdmission } from "../../../../src/orchestration/subscription-spend-consent/admission-capture.js"
import { createSubscriptionSpendConsentCaptureCache } from "../../../../src/orchestration/subscription-spend-consent/capture-cache.js"
import type { SubscriptionSpendConsentCapture } from "../../../../src/orchestration/subscription-spend-consent/subscription-spend-consent-service.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { HOLDS_DIRECTORY_VALUES } from "../../../helpers/held-directory-values.js"
import { POSIX_FAILURE_STAGING } from "../../../helpers/posix-failure-staging.js"
import { definition, registry, writeAccounts } from "../auth/provider-observations/_service-fixtures.js"

const temporaryDirectory = temporaryDirectories()
const PROFILE_FILES = new Set(["auth.json", "model-preferences.json"])
const watchers: ActiveProfileWatcher[] = []
afterEach(() => { for (const watcher of watchers.splice(0)) watcher.dispose() })

async function workProfile() {
  const root = temporaryDirectory("held-profile-revisions-")
  const store = new AuthProfileStore(root)
  const access = await store.create("work", "Work")
  access.writeFile("auth.json", "{}")
  access.close()
  return { store, profile: { id: "work", directory: authDir(root, "work") } }
}

/** Counts reads of the files the eligibility revision derives from, whichever descriptor reads them. */
function profileFileReads() {
  const reads = spyOn(ContainedDirectory.prototype, "readFile")
  return {
    count: () => reads.mock.calls.filter(([name]) => PROFILE_FILES.has(name)).length,
    restore: () => { reads.mockRestore() },
  }
}

/** A watch confirms its hold at its first periodic revalidation after it armed. Where the platform holds
 *  nothing, it waits a few revalidations, after which every request still reads. */
async function confirmedWatch(store: AuthProfileStore, directory: string, options: Pick<ActiveProfileWatcherOptions, "watchDirectory"> = {}): Promise<void> {
  watchers.push(store.watchAuthFile(directory, () => {}, { debounceMs: 1, revalidateMs: 5, ...options }))
  if (!HOLDS_DIRECTORY_VALUES) {
    await Bun.sleep(25)
    return
  }
  const reads = profileFileReads()
  try {
    await until(() => {
      authProfileEligibilityInputRevision({ id: "work", directory })
      const before = reads.count()
      authProfileEligibilityInputRevision({ id: "work", directory })
      return reads.count() === before
    })
  } finally { reads.restore() }
}

/** The same held object where the platform holds values, and an equal fresh one where it computes every read. */
function expectHeld<T>(actual: T, held: T): void {
  if (HOLDS_DIRECTORY_VALUES) expect(actual).toBe(held)
  else expect(actual).toEqual(held)
}

/** Captures the periodic callbacks that watches schedule, so a case runs each revalidation itself. */
function capturedIntervals() {
  const revalidations: Array<Parameters<typeof setInterval>[0]> = []
  // A real handle, already cleared, stands in for each captured interval, so a watch still unrefs and clears it.
  const inert = setInterval(() => {}, 1_000_000)
  clearInterval(inert)
  const spy = spyOn(globalThis, "setInterval").mockImplementation(new Proxy(globalThis.setInterval, {
    apply(_target, _receiver, [revalidation]: Parameters<typeof setInterval>) {
      revalidations.push(revalidation)
      return inert
    },
  }))
  return {
    revalidate: () => { for (const revalidation of revalidations) if (typeof revalidation === "function") revalidation() },
    restore: () => { spy.mockRestore() },
  }
}

function refused(load: ReturnType<typeof heldAuthStoreLoad>): boolean {
  return load.conditions.some((condition) => condition.kind === "refused")
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return
    await Bun.sleep(5)
  }
  throw new Error("condition was not met")
}

describe("eligibility input revision held by the profile watch", () => {
  test("every request reads the profile files while no watch holds the profile", async () => {
    const { profile } = await workProfile()
    const reads = profileFileReads()
    try {
      for (let request = 0; request < 3; request += 1) authProfileEligibilityInputRevision(profile)
      expect(reads.count()).toBe(6)
    } finally { reads.restore() }
  })

  test("N requests read no profile file until a file they derive from changes", async () => {
    const { store, profile } = await workProfile()
    // Usage evidence is written in place beside the auth files on every request.
    writeFileSync(join(profile.directory, "subscription-usage-authority-v2.sqlite-wal"), "")
    // A controlled watch: FSEvents can deliver the setup writes late, which drops the hold for a reason this case does not measure.
    let emit: (name?: string) => void = () => { throw new Error("the watch did not arm") }
    await confirmedWatch(store, profile.directory, { watchDirectory: (_directory, onChanged) => { emit = onChanged; return { close: () => {} } } })
    const held = authProfileEligibilityInputRevision(profile)
    const reads = profileFileReads()
    try {
      for (let request = 0; request < 50; request += 1) expectHeld(authProfileEligibilityInputRevision(profile), held)
      expect(reads.count()).toBe(HOLDS_DIRECTORY_VALUES ? 0 : 100)
      appendFileSync(join(profile.directory, "subscription-usage-authority-v2.sqlite-wal"), "page")
      emit("subscription-usage-authority-v2.sqlite-wal")
      await Bun.sleep(30)
      // The watch's own revalidation reads auth.json after the event; the requests read nothing.
      const watchReads = reads.count()
      for (let request = 0; request < 50; request += 1) expectHeld(authProfileEligibilityInputRevision(profile), held)
      expect(reads.count()).toBe(watchReads + (HOLDS_DIRECTORY_VALUES ? 0 : 100))

      // Another process replaces auth.json: the next request after the watch event sees it.
      writeFileSync(join(profile.directory, "auth.json.next"), "{\"replaced\":true}")
      renameSync(join(profile.directory, "auth.json.next"), join(profile.directory, "auth.json"))
      emit("auth.json")
      expect(authProfileEligibilityInputRevision(profile).auth).toBe(authStoreObservedRevision(profile.directory))
      expect(authProfileEligibilityInputRevision(profile).auth).not.toBe(held.auth)

      // A write in this process is seen by the very next request, before any watch event.
      const replaced = authProfileEligibilityInputRevision(profile)
      const access = openExistingAuthProfileDirectory(profile.directory)
      try { access.writeFile("model-preferences.json", "{}") } finally { access.close() }
      expect(authProfileEligibilityInputRevision(profile).preferences).not.toBe(replaced.preferences)
    } finally { reads.restore() }
  })

  test("an in-place edit that no watch event reports is seen within the revalidation period", async () => {
    const { store, profile } = await workProfile()
    writeFileSync(join(profile.directory, "model-preferences.json"), "{}")
    await confirmedWatch(store, profile.directory, { watchDirectory: () => ({ close: () => {} }) })
    const held = authProfileEligibilityInputRevision(profile)
    // The same file, edited where it is: no directory entry changes.
    writeFileSync(join(profile.directory, "model-preferences.json"), "{\"edited\":true}")
    await until(() => authProfileEligibilityInputRevision(profile).preferences !== held.preferences)
  })

  test("a replaced profile directory returns requests to their own reads", async () => {
    const { store, profile } = await workProfile()
    // A silent watch confirms at its first revalidation; only the revalidation can see the replacement.
    watchers.push(store.watchAuthFile(profile.directory, () => {}, { debounceMs: 1, revalidateMs: 5, watchDirectory: () => ({ close: () => {} }) }))
    await Bun.sleep(25)
    const reads = profileFileReads()
    try {
      authProfileEligibilityInputRevision(profile)
      authProfileEligibilityInputRevision(profile)
      expect(reads.count()).toBe(HOLDS_DIRECTORY_VALUES ? 2 : 4)
    } finally { reads.restore() }
    renameSync(profile.directory, `${profile.directory}-detached`)
    await store.create("work", "Work")
    await Bun.sleep(25)
    const replaced = profileFileReads()
    try {
      authProfileEligibilityInputRevision(profile)
      authProfileEligibilityInputRevision(profile)
      expect(replaced.count()).toBe(4)
    } finally { replaced.restore() }
  })
})

describe("auth store observation held by the profile watch", () => {
  test("N observations read auth.json once until it or the credential vocabulary changes", async () => {
    const { store, profile } = await workProfile()
    await confirmedWatch(store, profile.directory)
    const first = heldAuthStoreLoad(profile.directory)
    const reads = profileFileReads()
    try {
      for (let request = 0; request < 50; request += 1) expectHeld(heldAuthStoreLoad(profile.directory), first)
      if (HOLDS_DIRECTORY_VALUES) expect(reads.count()).toBe(0)
      else expect(reads.count()).toBeGreaterThanOrEqual(50)

      // A credential this process saves is seen by the next observation. Its provider is not installed yet.
      const access = openExistingAuthProfileDirectory(profile.directory)
      try { access.writeFile("auth.json", JSON.stringify({ local_llm: { type: "api_key", key: "sk-local" } })) } finally { access.close() }
      const saved = heldAuthStoreLoad(profile.directory)
      expect(saved.revision).not.toBe(first.revision)
      expect(saved.store.local_llm).toBeUndefined()

      // A [custom_providers] edit installs the provider with no file change: the next observation decodes it.
      installCustomProviders([{ id: "local_llm", displayName: "Local", baseUrl: "http://127.0.0.1:1/v1", modelIds: new Set(["local-model"]), catalogId: undefined, contextLimit: 8192 }])
      expect(heldAuthStoreLoad(profile.directory).store.local_llm).toEqual({ type: "api_key", key: "sk-local" })
    } finally {
      reads.restore()
      installCustomProviders([])
    }
  })

  test("every request shares one load that no request can change", async () => {
    const { store, profile } = await workProfile()
    await confirmedWatch(store, profile.directory)
    const load = heldAuthStoreLoad(profile.directory)
    expect(Reflect.set(load.store, "injected", { type: "api_key", key: "sk-injected" })).toBe(false)
    expect(Reflect.set(load.conditions, 0, { kind: "refused" })).toBe(false)
    expect(heldAuthStoreLoad(profile.directory).store).toEqual({})
  })

  test("a removed auth.json or model-preferences.json is seen by the next request", async () => {
    const { store, profile } = await workProfile()
    const access = openExistingAuthProfileDirectory(profile.directory)
    try {
      access.writeFile("auth.json", JSON.stringify({ local_llm: { type: "api_key", key: "sk-local" } }))
      access.writeFile("model-preferences.json", "{}")
      // A silent watch: only the removal's own note can drop the held values before the next request.
      await confirmedWatch(store, profile.directory, { watchDirectory: () => ({ close: () => {} }) })
      const revision = authProfileEligibilityInputRevision(profile)
      const load = heldAuthStoreLoad(profile.directory)
      access.removeFile("model-preferences.json")
      expect(authProfileEligibilityInputRevision(profile).preferences).not.toBe(revision.preferences)
      access.removeFile("auth.json")
      expect(authProfileEligibilityInputRevision(profile).auth).not.toBe(revision.auth)
      expect(heldAuthStoreLoad(profile.directory).revision).not.toBe(load.revision)
    } finally { access.close() }
  })

  test.if(HOLDS_DIRECTORY_VALUES)("a refused load is never held, and a symlink in place of the profile's parent ends the hold", async () => {
    const { store, profile } = await workProfile()
    const profiles = dirname(profile.directory)
    const intervals = capturedIntervals()
    try {
      // A silent watch: only the revalidations this case runs change what is held.
      watchers.push(store.watchAuthFile(profile.directory, () => {}, { debounceMs: 1, revalidateMs: 5, watchDirectory: () => ({ close: () => {} }) }))
    } finally { intervals.restore() }
    const unsafeParent = (): void => {
      renameSync(profiles, `${profiles}-real`)
      symlinkSync(`${profiles}-real`, profiles)
    }
    const restoreParent = (): void => {
      renameSync(profiles, `${profiles}-link`)
      renameSync(`${profiles}-real`, profiles)
    }
    intervals.revalidate()

    // The parent turns unsafe and is restored in place between two revalidations: no file or directory identity changes.
    unsafeParent()
    expect(refused(heldAuthStoreLoad(profile.directory))).toBe(true)
    restoreParent()
    const restored = heldAuthStoreLoad(profile.directory)
    expect(refused(restored)).toBe(false)

    // A held load does not hide a parent that turned unsafe after it was held.
    expectHeld(heldAuthStoreLoad(profile.directory), restored)
    unsafeParent()
    intervals.revalidate()
    expect(refused(heldAuthStoreLoad(profile.directory))).toBe(true)
  })

  test.if(POSIX_FAILURE_STAGING)("a revalidation that cannot examine the profile's parent ends the hold instead of throwing", async () => {
    const { store, profile } = await workProfile()
    const profiles = dirname(profile.directory)
    const intervals = capturedIntervals()
    try {
      watchers.push(store.watchAuthFile(profile.directory, () => {}, { debounceMs: 1, revalidateMs: 5 }))
    } finally { intervals.restore() }
    intervals.revalidate()
    heldAuthStoreLoad(profile.directory)
    chmodSync(profiles, 0o000)
    try {
      expect(intervals.revalidate).not.toThrow()
    } finally { chmodSync(profiles, 0o700) }
    const reads = profileFileReads()
    try {
      heldAuthStoreLoad(profile.directory)
      heldAuthStoreLoad(profile.directory)
      expect(reads.count()).toBeGreaterThanOrEqual(2)
    } finally { reads.restore() }
  })
})

describe("subscription consent revision held by the profile watch", () => {
  test("cached consent admissions read no consent file and open no profile directory until consent changes", async () => {
    const { store, profile } = await workProfile()
    const provider = definition("github_copilot")
    writeAccounts(profile.directory, [provider])
    // A silent watch: a change that no note reports is seen only by the periodic revalidation.
    await confirmedWatch(store, profile.directory, { watchDirectory: () => ({ close: () => {} }) })
    const providers = registry([provider], new Map())
    const pool = createSubscriptionUsageServicePool({ create: (resolved) => createSubscriptionUsageService({ profile: () => resolved, registry: () => providers, thresholds: () => [] }) })
    const residentLease = await pool.acquire(profile)
    const consentCache = createSubscriptionSpendConsentCaptureCache<SubscriptionSpendConsentCapture>()
    const admit = () => captureSubscriptionAdmission({
      candidates: [], providerSettings: {}, registry: { allowance: new Map(), settings: new Map(), selection: providers.selection },
      profile, residentLease, pool, consentCache,
    })
    try {
      // The first admission saves the missing consent authority; the second caches its capture.
      await admit()
      const first = await admit()
      const consentFile = join(profile.directory, "subscription-spend-consent-v1.sqlite")
      const firstBytes = readFileSync(consentFile)
      const reads = spyOn(ContainedDirectory.prototype, "readFile")
      const opens = spyOn(ContainedDirectory, "openExisting")
      try {
        for (let request = 0; request < 20; request += 1) expect((await admit()).consent).toBe(first.consent)
        const consentReads = reads.mock.calls.filter(([name]) => name === "subscription-spend-consent-v1.sqlite").length
        if (HOLDS_DIRECTORY_VALUES) {
          expect(consentReads).toBe(0)
          expect(opens).not.toHaveBeenCalled()
        } else {
          expect(consentReads).toBeGreaterThanOrEqual(20)
          expect(opens.mock.calls.length).toBeGreaterThanOrEqual(20)
        }

        // A consent decision saved in this process is seen by the next admission.
        const account = createSubscriptionAccountIdentity(provider.id, "account", "github_copilot-identity")
        const envelope = createSubscriptionSpendEnvelope(profile.id, account, "automatic")
        const access = openExistingAuthProfileDirectory(profile.directory)
        try {
          const consent = createSubscriptionSpendConsentStore({ profileId: profile.id, access, currentAccounts: () => [account] })
          const saved = await consent.read([envelope])
          await consent.save({ expectedIncarnation: saved.incarnation, expectedRevision: saved.revision, envelopes: [envelope], acceptedEnvelopeIds: [envelope.id], reviewedEnvelopeIds: [envelope.id] })
        } finally { access.close() }
        const saved = (await admit()).consent
        expect(saved).not.toBe(first.consent)

        // Another process rewrites the consent file in place: the admission after the next revalidation sees it.
        writeFileSync(consentFile, firstBytes)
        let current = saved
        for (let attempt = 0; attempt < 400 && current === saved; attempt += 1) {
          await Bun.sleep(5)
          current = (await admit()).consent
        }
        expect(current).not.toBe(saved)
      } finally {
        reads.mockRestore()
        opens.mockRestore()
      }
    } finally {
      await residentLease.release()
      pool.closeAdmission()
      await pool.settled()
    }
  })
})
