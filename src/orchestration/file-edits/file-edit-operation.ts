import { resolve } from "node:path"
import { PersistenceWriteRefused } from "../../infra/event-store-types.js"
import { ContainedPathError, type ContainedFileMetadata, type ContainedFileSnapshot, type FileMutationAttemptResult } from "../../infra/descriptor-directory-contract.js"
import { withMutationQueueKeys } from "../../infra/file-mutation-queue.js"
import { runInTaskSlices } from "../../infra/task-scheduling.js"
import { prepareFileMutationOperation, retireFileMutationNotApplied, settleFileMutation, type FileMutationFactWriter, type FileMutationPlan, type PreparedFileMutation } from "../session/file-mutations/file-mutation-fact-writers.js"
import type { FileMutationOrigin } from "../session/file-mutations/file-mutation-facts.js"
import { snapshotToFileObjectProof, type FilePreconditionProof } from "../session/file-mutations/file-mutation-operation.js"
import { observeFileState, sameObservedState, type ExpectedFileState } from "./file-state.js"
import type { AdmittedFileSummary } from "./retained-file-edit-host.js"

/** One retained target. Publication performs its own per-item compare-and-swap even after preflight. */
export interface FileEditAuthority {
  readonly canonicalPath: string
  /** What admission found at the target, or undefined when no file was there. */
  readonly admittedFile: AdmittedFileSummary | undefined
  readonly text: string | undefined
  readonly mayCreateMissingParents: boolean
  /** A detached copy of the admitted target state; changing it never changes the publication baseline. */
  admittedSnapshot(): ContainedFileSnapshot | undefined
  /** A detached copy of the admitted access metadata. */
  admittedMetadata(): ContainedFileMetadata | undefined
  /** The SHA-256 hex digest of the admitted bytes, or undefined when no file was there. */
  admittedSha256(): string | undefined
  encode(content: string): Buffer
  verifyPrecondition(): void
  publish(bytes: Uint8Array, metadata?: ContainedFileMetadata): FileMutationAttemptResult
  delete(): FileMutationAttemptResult
  readBackAndVerify(bytes: Uint8Array, metadata?: ContainedFileMetadata): ContainedFileSnapshot
  verifyAbsent(): void
  defaultPublicationMetadata(): ContainedFileMetadata | undefined
  close(): void
}

export interface AdmittedFileEdit {
  readonly path: string
  readonly resolvedPath: string
  readonly authority: FileEditAuthority
}

/** An undefined after deletes the target. Text is encoded by the authority; bytes publish exactly. Origin overrides are per item, not per operation. */
export interface PlannedFileEdit {
  readonly conflictMarkers?: boolean
  readonly admitted: AdmittedFileEdit
  readonly after: string | Uint8Array | undefined
  readonly metadata?: ContainedFileMetadata
  readonly origin?: FileMutationOrigin
}

/** Runs after admission read the target, so an unchanged fingerprint proves the admitted bytes are the expected ones. */
function admittedAsExpected(authority: FileEditAuthority, expected: ExpectedFileState): boolean {
  if (expected.kind === "absent") return authority.admittedFile === undefined
  if (authority.admittedFile?.byteLength !== expected.size) return false
  if (expected.sha256 !== undefined && authority.admittedSha256() !== expected.sha256) return false
  return sameObservedState(observeFileState(authority.canonicalPath), expected)
}

export class FileEditRefusal extends Error {}

/** Without a writer, standalone callers publish no durable mutation or tool facts. */
export interface FileEditContext {
  readonly executionCwd: string
  readonly signal?: AbortSignal
  readonly sessionEventWriter?: FileMutationFactWriter
  readonly origin?: FileMutationOrigin
}

export interface FileEditPublication<Plan extends PlannedFileEdit = PlannedFileEdit> {
  readonly plan: Plan
  /** The one detached copy of the admitted target state that this publication takes, so every later reader of the
   *  old bytes shares it instead of copying them again. Undefined when no file was there. */
  readonly before: ContainedFileSnapshot | undefined
  readonly bytes: Buffer | undefined
  readonly mutation: PreparedFileMutation | undefined
}

export interface FileEditOperationOptions<Plan extends PlannedFileEdit = PlannedFileEdit> {
  readonly paths: readonly string[]
  readonly admit: (resolvedPath: string) => FileEditAuthority
  readonly plan: (admitted: readonly AdmittedFileEdit[]) => readonly Plan[] | Promise<readonly Plan[]>
  readonly resolvePath?: (cwd: string, path: string) => string
  /** Per path in `paths`: the state the caller requires the target to hold. A path whose state differs before or
   * after admission, or whose path a symlink or non-directory now holds, is a conflict: it is neither planned nor
   * published. A path that leaves its state after preparation is refused alone when its publication is proven not
   * applied. Either way the other paths continue. */
  readonly expected?: ReadonlyMap<string, ExpectedFileState>
  readonly withQueues?: <T>(keys: readonly string[], run: () => Promise<T>) => Promise<T>
  /** Runs after asynchronous durable preparation, under every queue, before any publication. Throw to refuse the entire prepared operation. */
  readonly preflight?: (publications: readonly FileEditPublication<Plan>[]) => void | Promise<void>
  readonly onPrepared?: (publications: readonly FileEditPublication<Plan>[]) => void | Promise<void>
  /** Observes each durable settlement before the next item starts. Owns no filesystem or durable mutation state. */
  readonly onSettled?: (publication: FileEditPublication<Plan>) => void | Promise<void>
}

type PublicationPrefix<Plan extends PlannedFileEdit> = {
  readonly committedPrefix: readonly FileEditPublication<Plan>[]
  readonly untouchedSuffix: readonly FileEditPublication<Plan>[]
}

/** Why an operation wrote nothing: cancellation carries no error, and every
 *  preflight or publication refusal carries the error that refused it. */
export type NotAppliedRefusal =
  | { readonly reason: "cancelled" }
  | { readonly reason: "preflight" | "publication"; readonly error: unknown }

/** A failed settlement never makes applied bytes a proven refusal. Retirement errors preserve proof that no publication occurred. */
type PublicationAttempt<Plan extends PlannedFileEdit> = PublicationPrefix<Plan> & (
  | { readonly status: "completed" }
  | ({ readonly status: "not_applied"; readonly current: FileEditPublication<Plan>; readonly retirementError?: unknown } & NotAppliedRefusal)
  | { readonly status: "uncertain"; readonly current: FileEditPublication<Plan>; readonly stage: "publication" | "readback" | "settlement" | "observer"; readonly publication: "unknown" | "applied"; readonly settlement: "pending" | "committed"; readonly error: unknown }
)

/** `conflicts` names, in `paths` order, every path excluded because it left its expected state. */
export type FileEditPublicationOutcome<Plan extends PlannedFileEdit = PlannedFileEdit> = PublicationAttempt<Plan> & { readonly conflicts: readonly string[] }

/** Plans once before queue acquisition. Each item publishes, reads back and settles before the next begins.
 * Admission, planning and preparation failures throw; publication failures return the exact prefix and suffix.
 * When every path conflicts, nothing is planned and the operation completes empty.
 * Queues do not turn independent filesystem publications into a cross-file transaction. Authorities always close. */
export async function publishFileEdits<Plan extends PlannedFileEdit>(context: FileEditContext, options: FileEditOperationOptions<Plan>): Promise<FileEditPublicationOutcome<Plan>> {
  const admitted: AdmittedFileEdit[] = []
  const conflicted = new Set<string>()
  const outcome = (attempt: PublicationAttempt<Plan>): FileEditPublicationOutcome<Plan> => ({ ...attempt, conflicts: options.paths.filter(path => conflicted.has(path)) })
  try {
    await runInTaskSlices("file-edit-admission", (function* () {
      for (const path of options.paths) {
        yield
        const resolvedPath = (options.resolvePath ?? resolve)(context.executionCwd, path)
        const expected = options.expected?.get(path)
        // The check before admission keeps a target that no longer has the expected shape, such as a new symlink, from failing admission for every path.
        if (expected && !sameObservedState(observeFileState(resolvedPath), expected)) {
          conflicted.add(path)
          continue
        }
        let authority: FileEditAuthority
        try {
          authority = options.admit(resolvedPath)
        } catch (error) {
          // A symlink or non-directory that now holds part of the path is a changed target, not a failed operation.
          if (!expected || !(error instanceof ContainedPathError)) throw error
          conflicted.add(path)
          continue
        }
        if (expected && !admittedAsExpected(authority, expected)) {
          authority.close()
          conflicted.add(path)
          continue
        }
        admitted.push({ path, resolvedPath, authority })
      }
    })())
    if (admitted.length === 0 && conflicted.size > 0) return outcome({ status: "completed", committedPrefix: [], untouchedSuffix: [] })
    return outcome(await publishAdmitted(context, options, admitted, conflicted))
  } finally {
    for (const entry of admitted.toReversed()) entry.authority.close()
  }
}

async function publishAdmitted<Plan extends PlannedFileEdit>(context: FileEditContext, options: FileEditOperationOptions<Plan>, admitted: readonly AdmittedFileEdit[], conflicted: Set<string>): Promise<PublicationAttempt<Plan>> {
  const plans = await options.plan(admitted)
  if (plans.length === 0) return { status: "completed", committedPrefix: [], untouchedSuffix: [] }
  const authorities = new Set(admitted.map(entry => entry.authority))
  for (const plan of plans) {
    if (!authorities.has(plan.admitted.authority)) throw new Error(`File edit plan introduced an unadmitted target (${plan.admitted.path})`)
  }
  const publications = await preparePublications(context, plans).catch((error: unknown) => {
    if (error instanceof PersistenceWriteRefused) error.stage = "preparation"
    throw error
  })
  await options.onPrepared?.(publications)
  const keys = [...new Set(publications.map(item => item.plan.admitted.authority.canonicalPath))].sort()
  return await (options.withQueues ?? withMutationQueueKeys)(keys, async () => {
    // SAFETY: plans is nonempty above, and preparePublications preserves its length.
    const first = publications[0]!
    if (context.signal?.aborted) return refuse(context, first, [], publications.slice(1), { reason: "cancelled" })
    try {
      if (options.preflight) await options.preflight(publications)
    } catch (error) {
      return refuse(context, first, [], publications.slice(1), { reason: "preflight", error })
    }
    return publishPrepared(context, options, publications, conflicted)
  })
}

async function preparePublications<Plan extends PlannedFileEdit>(context: FileEditContext, plans: readonly Plan[]): Promise<readonly FileEditPublication<Plan>[]> {
  const outputs = plans.map(plan => plan.after === undefined ? undefined : typeof plan.after === "string" ? plan.admitted.authority.encode(plan.after) : Buffer.from(plan.after.buffer, plan.after.byteOffset, plan.after.byteLength))
  const befores = plans.map(plan => plan.admitted.authority.admittedSnapshot())
  const mutationPlans: FileMutationPlan[] = plans.map((plan, index) => {
    const { authority } = plan.admitted
    const before = befores[index]
    return {
      change: {
        path: authority.canonicalPath,
        displayPath: plan.admitted.path,
        changeKind: before === undefined ? "created" : plan.after === undefined ? "deleted" : "modified",
        beforeContent: before?.content ?? null,
        afterContent: outputs[index] ?? null,
      },
      evidence: {
        beforeSnapshot: before ?? null,
        ...(plan.metadata ?? before?.metadata ? { postconditionAccess: plan.metadata ?? before?.metadata } : {}),
        ...(authority.mayCreateMissingParents ? { mayCreateMissingParents: true } : {}),
      },
      ...(plan.conflictMarkers === undefined ? {} : { conflictMarkers: plan.conflictMarkers }),
      ...(plan.origin ? { origin: plan.origin } : {}),
    }
  })
  if (context.sessionEventWriter && !context.origin) throw new Error("File mutation publication requires an origin")
  const mutations = context.origin ? await prepareFileMutationOperation({ sessionEventWriter: context.sessionEventWriter, origin: context.origin }, mutationPlans) : []
  return plans.map((plan, index) => ({
    plan,
    before: befores[index],
    bytes: outputs[index],
    mutation: mutations[index],
  }))
}

async function refuse<Plan extends PlannedFileEdit>(context: FileEditContext, current: FileEditPublication<Plan>, committedPrefix: readonly FileEditPublication<Plan>[], untouchedSuffix: readonly FileEditPublication<Plan>[], refusal: NotAppliedRefusal): Promise<PublicationAttempt<Plan>> {
  const result = { status: "not_applied" as const, current, committedPrefix, untouchedSuffix, ...refusal }
  try {
    if (current.mutation) await retireFileMutationNotApplied(context, current.mutation)
    return result
  } catch (retirementError) {
    if (retirementError instanceof PersistenceWriteRefused) {
      retirementError.stage = committedPrefix.length ? "publication" : "preparation"
      throw retirementError
    }
    return { ...result, retirementError }
  }
}

async function publishPrepared<Plan extends PlannedFileEdit>(context: FileEditContext, options: FileEditOperationOptions<Plan>, publications: readonly FileEditPublication<Plan>[], conflicted: Set<string>): Promise<PublicationAttempt<Plan>> {
  const committedPrefix: FileEditPublication<Plan>[] = []
  for (const [index, current] of publications.entries()) {
    const untouchedSuffix = publications.slice(index + 1)
    if (context.signal?.aborted) return refuse(context, current, committedPrefix, untouchedSuffix, { reason: "cancelled" })
    const { authority } = current.plan.admitted
    const metadata = current.plan.metadata ?? authority.admittedMetadata()
    let attempt: FileMutationAttemptResult
    try {
      attempt = current.bytes === undefined ? authority.delete() : authority.publish(current.bytes, metadata)
    } catch (error) {
      attempt = { status: "indeterminate", error: error instanceof Error ? error : new Error(String(error)) }
    }
    if (attempt.status === "not_applied") {
      const { path, resolvedPath } = current.plan.admitted
      const expected = options.expected?.get(path)
      // Nothing was published, so a target that has left its expected state is a proven conflict: the
      // item is retired alone and the rest still publish. Any other refusal stops the operation.
      if (!expected || sameObservedState(observeFileState(resolvedPath), expected)) return refuse(context, current, committedPrefix, untouchedSuffix, { reason: "publication", error: attempt.error })
      try {
        if (current.mutation) await retireFileMutationNotApplied(context, current.mutation, "item")
      } catch (retirementError) {
        if (retirementError instanceof PersistenceWriteRefused) {
          retirementError.stage = committedPrefix.length ? "publication" : "preparation"
          throw retirementError
        }
        return { status: "not_applied", current, committedPrefix, untouchedSuffix, reason: "publication", error: attempt.error, retirementError }
      }
      conflicted.add(path)
      continue
    }
    if (attempt.status === "indeterminate") return { status: "uncertain", current, committedPrefix, untouchedSuffix, stage: "publication", publication: "unknown", settlement: "pending", error: attempt.error }
    let stage: "readback" | "settlement" | "observer" = "readback"
    try {
      let after: FilePreconditionProof
      if (current.bytes === undefined) {
        authority.verifyAbsent()
        after = { kind: "absent" }
      } else after = snapshotToFileObjectProof(authority.readBackAndVerify(current.bytes, metadata))
      stage = "settlement"
      if (current.mutation) await settleFileMutation(context, current.mutation, after)
      stage = "observer"
      await options.onSettled?.(current)
      committedPrefix.push(current)
    } catch (error) {
      if (error instanceof PersistenceWriteRefused) {
        error.stage = "publication"
        throw error
      }
      return { status: "uncertain", current, committedPrefix, untouchedSuffix, stage, publication: "applied", settlement: stage === "observer" ? "committed" : "pending", error }
    }
  }
  return { status: "completed", committedPrefix, untouchedSuffix: [] }
}
