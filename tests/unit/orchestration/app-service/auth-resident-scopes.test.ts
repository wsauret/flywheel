import { expect, test } from "bun:test"
import { authDir } from "../../../../src/infra/paths.js"
import { accessProviderRegistry } from "../../../../src/orchestration/agent-runtime/llm/access-provider-registry.js"
import { createResidentAuthScopes } from "../../../../src/orchestration/app-service/auth-resident-scopes.js"
import type { AuthProfileResolution } from "../../../../src/orchestration/auth/auth-profile-manager.js"
import { createSubscriptionUsageService } from "../../../../src/orchestration/auth/provider-observations/subscription-usage-service.js"
import { createSubscriptionUsageServicePool } from "../../../../src/orchestration/auth/provider-observations/subscription-usage-service-pool.js"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js"
import { temporaryDirectories } from "../../../helpers/directories.js"

const temporaryDirectory = temporaryDirectories()

test("an active workflow member whose run names a profile this account lacks holds no resident scope", async () => {
  const userDataRoot = temporaryDirectory("flywheel-resident-scopes-")
  const registry = accessProviderRegistry(composeFirstPartyModules([]))
  const profiles = (ids: readonly string[]): AuthProfileResolution => ({
    id: "Personal", persistedId: "Personal", displayName: "Personal", source: "sticky", directory: authDir(userDataRoot, "Personal"),
    availableProfiles: ids.map((id) => ({ id, displayName: id })), retirements: {}, projectBinding: undefined,
  })
  let defaults = profiles(["Personal", "Shared"])
  const pool = createSubscriptionUsageServicePool({
    create: (profile, thresholds) => createSubscriptionUsageService({ profile: () => profile, thresholds: () => thresholds, registry: () => registry }),
  })
  const resident = createResidentAuthScopes({
    manager: { read: async () => null },
    runs: { read: async () => ({ authProfileId: "Shared" }) },
    userDataRoot,
    currentProfile: () => defaults,
    resolveProfile: async () => defaults,
    disposed: () => false,
    pool,
  })
  const member = { kind: "workflow-agent", workflowMembership: { workflowId: "wf-shared" }, lifecycleState: "active" } as const
  const leasedProfiles = () => [...resident.leases].map(([key, { lease }]) => ({ key, profileId: lease.profile.id }))
  try {
    await resident.reconcile({ kind: "session", sessionId: "member" }, member)
    expect(leasedProfiles()).toEqual([{ key: "session:member", profileId: "Shared" }])

    defaults = profiles(["Personal"])
    await resident.reconcile({ kind: "session", sessionId: "member" }, member)
    expect(leasedProfiles()).toEqual([])
  } finally {
    pool.closeAdmission()
    await pool.settled()
  }
})
