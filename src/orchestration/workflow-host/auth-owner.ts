import type { AuthProfileManager, AuthProfileResolution } from "../auth/auth-profile-manager.js"
import { Log } from "../../infra/log.js"
import { MissingAuthProfileError, resolveSessionAuthProfile as resolveSelection } from "../session/metadata/session-auth-profile.js"
import { resolveSessionAuthProfile } from "../app-service/auth/auth-profile-scope.js"
import type { WorkflowRunReader, WorkflowRunRecord, WorkflowRunWriter } from "./run-record.js"

const log = Log.create({ service: "workflow-auth" })

/** Workflow configuration and status have no session cursor. The workflow protocol exposes this owner. */
export interface WorkflowAuthOwner {
  snapshot(workflowId: string): Promise<AuthProfileResolution>
  select(workflowId: string, profileId: string): Promise<boolean>
  /** Every run that can still take a turn, with its profile. A run whose
   *  profile this account lacks stays out, so it gets no resident scope and
   *  cannot keep the project from opening; its own snapshot still reports
   *  the missing profile. */
  list(): Promise<readonly { readonly workflowId: string; readonly profile: AuthProfileResolution }[]>
  /** The profile of one run while it can still take a turn. Undefined when
   *  the run is missing, deleted, or completed, or names a profile this
   *  account lacks. */
  resident(workflowId: string): Promise<AuthProfileResolution | undefined>
}

/** Resolves environment selection and durable retirement without copying run policy into member metadata. */
export function createWorkflowAuthOwner(input: {
  readonly reader: WorkflowRunReader
  readonly writer: WorkflowRunWriter
  readonly profiles: Pick<AuthProfileManager, "inspect">
  readonly userDataRoot: string
  readonly onSelected: (workflowId: string) => Promise<void>
}): WorkflowAuthOwner {
  /** Resolves `read` against `inspected`, and persists a selection that a
   *  retirement or a missing choice changed before it reads the run again. */
  const settle = async (workflowId: string, read: WorkflowRunRecord | null, inspected: AuthProfileResolution): Promise<AuthProfileResolution> => {
    let run = read
    let defaults = inspected
    for (;;) {
      if (!run) throw new Error(`Workflow not found: ${workflowId}`)
      const expected = run.authProfileId
      const selection = resolveSelection(run, defaults)
      if (expected === selection.persistedId) return resolveSessionAuthProfile(run, defaults, input.userDataRoot)
      await input.writer.update(workflowId, (current) => current.authProfileId !== expected ? null : { ...current, authProfileId: selection.persistedId })
      run = await input.reader.read(workflowId)
      defaults = input.profiles.inspect()
    }
  }
  // Each reconciliation of a run resolves it again, so a missing profile is
  // reported once for each run, not once for each resolution.
  const reportedMissing = new Set<string>()
  const resolveResident = async (workflowId: string, run: WorkflowRunRecord, defaults: AuthProfileResolution): Promise<AuthProfileResolution | undefined> => {
    try {
      return await settle(workflowId, run, defaults)
    } catch (error) {
      if (!(error instanceof MissingAuthProfileError)) throw error
      if (!reportedMissing.has(workflowId)) {
        reportedMissing.add(workflowId)
        log.warn("workflow auth profile does not exist", { workflowId, profileId: error.profileId })
      }
      return undefined
    }
  }
  const snapshot = async (workflowId: string): Promise<AuthProfileResolution> =>
    settle(workflowId, await input.reader.read(workflowId), input.profiles.inspect())
  return {
    snapshot,
    async select(workflowId, profileId) {
      const defaults = input.profiles.inspect()
      if (defaults.source === "environment") throw new Error("cannot switch the environment-selected auth profile")
      if (!defaults.availableProfiles.some(({ id }) => id === profileId)) throw new Error(`auth profile does not exist: ${profileId}`)
      for (;;) {
        const run = await input.reader.read(workflowId)
        if (!run) return false
        if (run.authProfileId === profileId) return true
        if (!await input.writer.update(workflowId, (current) => current.authProfileId !== run.authProfileId ? null : { ...current, authProfileId: profileId })) continue
        await input.onSelected(workflowId)
        return true
      }
    },
    // The list resolves each run from the one listed fold and one inspection
    // of the profile directory.
    async list() {
      const defaults = input.profiles.inspect()
      const resolved = await Promise.all((await input.reader.listOpen()).map(async ({ workflowId, run }) => {
        const profile = await resolveResident(workflowId, run, defaults)
        return profile ? [{ workflowId, profile }] : []
      }))
      return resolved.flat()
    },
    async resident(workflowId) {
      const run = await input.reader.readOpen(workflowId)
      return run ? resolveResident(workflowId, run, input.profiles.inspect()) : undefined
    },
  }
}
