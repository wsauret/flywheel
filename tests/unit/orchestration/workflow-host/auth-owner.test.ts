import { describe, expect, it, spyOn } from "bun:test"
import { Log } from "../../../../src/infra/log.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import type { AuthProfileResolution } from "../../../../src/orchestration/auth/auth-profile-manager.js"
import { createWorkflowRunWriter } from "../../../../src/orchestration/modules/workflows/run-facts.js"
import { createWorkflowRunReader } from "../../../../src/orchestration/modules/workflows/run-record.js"
import { createWorkflowAuthOwner } from "../../../../src/orchestration/workflow-host/auth-owner.js"
import { countStateRequests } from "../../../helpers/state-requests.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { publishWorkerAttempt } from "./_workflow-host-fixtures.js"

const temporary = temporaryDirectories()

const DEFAULTS: AuthProfileResolution = {
  id: "Personal",
  persistedId: "Personal",
  displayName: "Personal",
  source: "sticky",
  directory: "/scratch/auth/Personal",
  availableProfiles: [{ id: "Personal", displayName: "Personal" }],
  projectBinding: undefined,
  retirements: {},
}

/** Publishes `wf-0` with the default profile, then registers `wf-<n>` for
 *  each later entry of `profileIds` from wf-0's registration. */
async function seedWorkflows(dir: string, profileIds: readonly string[]) {
  const store = createSqliteEventStore(resolveEventStoreDbFile(dir))
  const base = asAsyncEventReadSurface(store)
  const { manager } = await publishWorkerAttempt({ projectRoot: dir, reader: base, writer: asAsyncEventWriter(store), workflowId: "wf-0", attemptId: "a", conversationId: "conv-0" })
  const [registration] = (await base.readSlice({ aggregateId: "workflow:wf-0", types: ["workflow.run.registered"] })).facts
  if (!registration || registration instanceof Error) throw new Error("the published workflow has no registration")
  const { type, version, actor, payload } = registration
  if (typeof payload !== "object" || payload === null || !("settings" in payload) || typeof payload.settings !== "object") throw new Error("the registration has no settings")
  for (let index = 1; index < profileIds.length; index++) {
    store.append({ type, version, actor, payload: { ...payload, settings: { ...payload.settings, authProfileId: profileIds[index] } }, aggregateId: `workflow:wf-${index}`, sessionId: `wf-${index}`, timestamp: 10 })
  }
  return { store, base, manager }
}

describe("workflow auth owner", () => {
  it("leaves a run whose profile this account lacks out of the list, logs it once, and keeps it failing alone", async () => {
    // A project whose run names a profile from another account must still
    // open: startup reconciles resident scopes from this list.
    const dir = temporary("flywheel-workflow-auth-missing-")
    const { store, base, manager } = await seedWorkflows(dir, ["Personal", "Personal", "Gone"])
    const warn = spyOn(Log.create({ service: "workflow-auth" }), "warn").mockImplementation(() => {})
    try {
      const reader = createWorkflowRunReader(base)
      const owner = createWorkflowAuthOwner({
        reader,
        writer: createWorkflowRunWriter(base, (...args) => manager.commitWorkflow(...args)),
        profiles: { inspect: () => DEFAULTS },
        userDataRoot: "/scratch",
        onSelected: async () => {},
      })
      expect((await owner.list()).map(({ workflowId }) => workflowId)).toEqual(["wf-0", "wf-1"])
      expect(await owner.list()).toHaveLength(2)
      expect(warn.mock.calls).toEqual([["workflow auth profile does not exist", { workflowId: "wf-2", profileId: "Gone" }]])
      await expect(owner.snapshot("wf-2")).rejects.toThrow("auth profile does not exist: Gone")
      expect((await reader.read("wf-2"))?.authProfileId).toBe("Gone")
    } finally {
      warn.mockRestore()
      store.close()
    }
  })

  it("lists every workflow's profile with the same reads and one profile inspection whatever the workflow count", async () => {
    // Every session change lists every workflow's profile. A list that read
    // each workflow by id made one change cost every workflow of the project,
    // and past the held projection limit each of those reads began at the
    // first fact of the store.
    const costOfList = async (workflows: number) => {
      const dir = temporary("flywheel-workflow-auth-list-")
      const { store, base, manager } = await seedWorkflows(dir, Array.from({ length: workflows }, () => "Personal"))
      try {
        const { reader, take } = countStateRequests(base)
        let inspections = 0
        const owner = createWorkflowAuthOwner({
          reader: createWorkflowRunReader(reader),
          writer: createWorkflowRunWriter(base, (...args) => manager.commitWorkflow(...args)),
          profiles: { inspect: () => { inspections++; return DEFAULTS } },
          userDataRoot: "/scratch",
          onSelected: async () => {},
        })
        expect((await owner.list()).map(({ profile }) => profile.id)).toEqual(Array.from({ length: workflows }, () => "Personal"))
        take()
        inspections = 0
        expect(await owner.list()).toHaveLength(workflows)
        return { requests: take().length, inspections }
      } finally {
        store.close()
      }
    }
    // More workflows than the held projection limit of 64 per family.
    expect(await costOfList(100)).toEqual(await costOfList(3))
    expect((await costOfList(3)).inspections).toBe(1)
  })
})
