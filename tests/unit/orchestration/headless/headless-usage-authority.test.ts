import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createUsageAuthority } from "../../../../src/infra/llm/usage-authority.js"
import { createHeadlessUsageAuthorityOwner } from "../../../../src/orchestration/headless/headless-usage-authority.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test("headless Usage authority drains the exact captured profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flywheel-headless-usage-"))
  roots.push(directory)
  const owner = createHeadlessUsageAuthorityOwner({ id: "profile-a", directory })

  await expect(owner.acquire({ profileId: "profile-b", profileDir: directory })).rejects.toThrow("profile mismatch")
  await expect(owner.acquire({ profileId: "profile-a", profileDir: `${directory}-other` })).rejects.toThrow("profile mismatch")

  const lease = await owner.acquire({ profileId: "profile-a", profileDir: directory })
  const generation = owner.generation()
  expect(generation.profileId).toBe("profile-a")
  owner.assertGeneration(generation)
  expect(() => owner.assertGeneration({ ...generation, authorityIncarnation: "recreated" })).toThrow("identity does not match")
  lease.append({
    attemptId: "10000000-0000-4000-8000-000000000001",
    occurredAt: "2026-09-02T00:00:00.000Z",
    profileId: "profile-a",
    attribution: { kind: "candidate", providerId: "anthropic" },
    spendMode: "direct_api",
    credentialLineage: "20000000-0000-4000-8000-000000000002",
    model: "claude-test",
    tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    classification: "real_spend",
    price: { kind: "priced", estimatedUsd: 0.25, rateCard: { input: 0.1, output: 0.15 }, provenance: "test" },
    currency: "USD", coverage: "complete",
  })

  let closed = false
  const settlement = owner.settled().then(() => { closed = true })
  await Promise.resolve()
  expect(closed).toBe(false)
  await expect(owner.acquire({ profileId: "profile-a", profileDir: directory })).rejects.toThrow("admission is closed")

  await lease.release()
  await settlement
  expect(closed).toBe(true)

  const reopened = createUsageAuthority({ profileDir: directory, profileId: "profile-a" })
  try {
    expect(reopened.rangeEntries({ startMs: Date.parse("2026-09-01T00:00:00.000Z"), endMs: Date.parse("2026-10-01T00:00:00.000Z") }).groups).toEqual([expect.objectContaining({ attempts: 1, estimatedUsd: 0.25 })])
  } finally {
    reopened.dispose()
  }
})
