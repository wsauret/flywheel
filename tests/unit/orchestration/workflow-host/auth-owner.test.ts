import { describe, expect, it, spyOn } from "bun:test"
import { Log } from "../../../../src/infra/log.js"
import type { AuthProfileResolution } from "../../../../src/orchestration/auth/auth-profile-manager.js"
import { createWorkflowRunWriter } from "../../../../src/orchestration/modules/workflows/run-facts.js"
import { createWorkflowRunReader } from "../../../../src/orchestration/modules/workflows/run-record.js"
import { createWorkflowAuthOwner } from "../../../../src/orchestration/workflow-host/auth-owner.js"
import { countStateRequests } from "../../../helpers/state-requests.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { commitWorkflowEvent, seedWorkflowRuns } from "./_workflow-host-fixtures.js"

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

describe("workflow auth owner", () => {
  it("leaves a run whose profile this account lacks out of the list, logs it once, and keeps it failing alone", async () => {
    // A project whose run names a profile from another account must still
    // open: startup reconciles resident scopes from this list.
    const dir = temporary("flywheel-workflow-auth-missing-")
    const { store, base, manager } = await seedWorkflowRuns(dir, ["Personal", "Personal", "Gone"])
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
    // Startup and a profile catalog change list every workflow's profile. A
    // list that read each workflow by id cost every workflow of the project,
    // and past the held projection limit each of those reads began at the
    // first fact of the store.
    const costOfList = async (workflows: number) => {
      const dir = temporary("flywheel-workflow-auth-list-")
      const { store, base, manager } = await seedWorkflowRuns(dir, Array.from({ length: workflows }, () => "Personal"))
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

  it("keeps a completed run, which takes no turn again, out of the list and gives it no resident profile", async () => {
    const dir = temporary("flywheel-workflow-auth-completed-")
    const { store, base, manager, workflow } = await seedWorkflowRuns(dir, ["Personal", "Personal"])
    try {
      const owner = createWorkflowAuthOwner({
        reader: createWorkflowRunReader(base),
        writer: createWorkflowRunWriter(base, (...args) => manager.commitWorkflow(...args)),
        profiles: { inspect: () => DEFAULTS },
        userDataRoot: "/scratch",
        onSelected: async () => {},
      })
      expect((await owner.list()).map(({ workflowId }) => workflowId)).toEqual(["wf-0", "wf-1"])
      expect((await owner.resident("wf-0"))?.id).toBe("Personal")

      await commitWorkflowEvent({ manager, projectionReader: base }, "wf-0", workflow, { type: "ATTEMPT_SUCCEEDED", outcome: { attemptId: "a", conversationId: "conv-0", handoff: { summary: "done" }, reassessment: null } })
      expect((await owner.list()).map(({ workflowId }) => workflowId)).toEqual(["wf-1"])
      expect(await owner.resident("wf-0")).toBeUndefined()
      expect((await owner.resident("wf-1"))?.id).toBe("Personal")
      expect(await owner.resident("wf-missing")).toBeUndefined()
      // The run stays readable history.
      expect((await owner.snapshot("wf-0")).id).toBe("Personal")
    } finally {
      store.close()
    }
  })
})
