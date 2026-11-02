/** The filesystem protocol of one confirmed global skill operation.
 *
 *  Every mutation publishes a whole package, never one file into a live
 *  directory: the confirmed bytes are staged in the destination store, the
 *  package the mutation replaces or moves is renamed into a hidden rollback
 *  location inside its own store, and the staged copy is published with one
 *  rename. Under the package locks the live package is revalidated against the
 *  plan's pre-state first, so two confirmed mutations of one package can never
 *  union into a package the user never approved.
 *
 *  Every state has one registry-visible package or none, and each step is
 *  resumable from the manifest, so a process that dies mid-publication leaves
 *  the next reader a state it can finish or roll back.
 *
 *  Bytes are never deleted to resolve a conflict. A rollback copy that cannot
 *  be restored, because the location it came from is occupied again, is moved
 *  to the store's quarantine area and named in the operation's terminal
 *  evidence. */

import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fsyncDirectory } from "../../../infra/atomic-write.js";
import { Log } from "../../../infra/log.js";
import { writeFileUnder } from "../../../infra/write-file-under.js";
import { packageDigestAt } from "./skill-package-planning.js";
import { destinationMatchesPlan, outgoingDirOf, planStaleness } from "./skill-mutation-plan.js";
import { openPendingAudit, type PendingAudit } from "./learning-journal.js";
import {
  manifestPath,
  advanceOperationManifest,
  proposalPath,
  quarantineDir,
  rollbackDir,
  stagingDir,
  writeOperationManifest,
  type OperationManifest,
  type OperationState,
} from "./skill-operation-manifest.js";
import { skillOperationTransitionedFact } from "../../../workflows/skill-facts.js";
import type { SkillMutationPlan } from "./skill-store-types.js";

const log = Log.create({ service: "global-skill-operation" });

type OperationOutcome =
  | { readonly kind: "published" }
  | { readonly kind: "refused"; readonly error: string };

export interface OperationRun {
  readonly outcome: OperationOutcome;
  /** The audit evidence this run journalled, in transition order. The manifest
   *  stays the progress authority; these facts only describe it. Each entry is
   *  durable before the manifest write it describes, so a caller with a session
   *  writer settles them now and a recovery pass without one leaves them in the
   *  outbox for the workspace that owes them. */
  readonly pending: readonly PendingAudit[];
}

/** Finish one authorized operation from whatever state it is in. The caller
 *  holds the package locks of every directory the plan names. */
export function runOperation(globalRoot: string, manifest: OperationManifest): OperationRun {
  const pending: PendingAudit[] = [];
  let current = manifest;
  const advance = (state: OperationState, detail?: string): void => {
    current = advanceOperationManifest(current, state, detail);
    pending.push(journalTransition(globalRoot, current));
    writeOperationManifest(globalRoot, current);
  };

  if (current.state === "claimed") {
    if (destinationMatchesPlan(current.plan)) {
      advance("published", "the destination already held the confirmed package");
    } else {
      const refusal = stage(globalRoot, current);
      if (refusal) return abandon(globalRoot, current, refusal, pending);
      advance("staged");
    }
  }
  if (current.state === "staged") {
    hideOutgoing(current);
    advance("hidden");
  }
  if (current.state === "hidden") {
    const refusal = publish(globalRoot, current);
    if (refusal) return abandon(globalRoot, current, refusal, pending);
    advance("published");
  }
  // The destination is durable now, so the hidden copy is cleanup state.
  advance("completed", complete(globalRoot, current));
  return { outcome: { kind: "published" }, pending };
}

/** Journal the audit evidence of one transition before the manifest write that
 *  commits it. The entry asserts that the manifest commits this transition, so a
 *  crash between the two leaves an entry a replay settles from the manifest
 *  itself: recorded once the transition is committed, dropped once the operation
 *  ends without it, and left alone while the operation is still live. */
function journalTransition(globalRoot: string, manifest: OperationManifest): PendingAudit {
  return openPendingAudit({
    storeDir: globalRoot,
    workspace: resolve(manifest.projectStoreDir, "../.."),
    fact: skillOperationTransitionedFact({
      operationId: manifest.operationId,
      proposalId: manifest.plan.proposalId,
      name: manifest.plan.name,
      reach: manifest.plan.reach,
      state: manifest.state,
      ...(manifest.outcomeDetail ? { detail: manifest.outcomeDetail } : {}),
    }),
    intended: { kind: "operation", operationId: manifest.operationId, transition: manifest.transition },
  });
}

/** Give up on an operation that can no longer publish the confirmed package,
 *  putting the package it hid back where it was. */
function abandon(
  globalRoot: string,
  manifest: OperationManifest,
  error: string,
  pending: PendingAudit[],
): OperationRun {
  const preserved = restoreOutgoing(manifest);
  rmSync(stagingDir(globalRoot, manifest.operationId), { recursive: true, force: true });
  const detail = preserved ? `${error} The package it replaced is preserved at ${preserved}.` : error;
  const refused = advanceOperationManifest(manifest, "refused", detail);
  pending.push(journalTransition(globalRoot, refused));
  writeOperationManifest(globalRoot, refused);
  log.warn("global skill operation refused", { operationId: manifest.operationId, name: manifest.plan.name, detail });
  return { outcome: { kind: "refused", error: detail }, pending };
}

/** Put the whole confirmed package on the destination's filesystem, after
 *  revalidating under the locks that the live package is still the one the plan
 *  was computed from. The publication that follows is then one rename. */
function stage(globalRoot: string, manifest: OperationManifest): string | undefined {
  const plan = manifest.plan;
  const refusal = revalidate(plan);
  if (refusal) return refusal;
  const staging = stagingDir(globalRoot, manifest.operationId);
  // A process that died mid-copy may have left part of the package here; the
  // staged copy is the whole confirmed package or nothing.
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  for (const file of plan.outcome.package.files) writeFileUnder(staging, file.path, file.content);
  fsyncDirectory(staging);
  return undefined;
}

/** Why the confirmed transition no longer applies to what is installed. */
function revalidate(plan: SkillMutationPlan): string | undefined {
  switch (planStaleness(plan)) {
    case undefined: return undefined;
    case "creation_conflict": return `A package named "${plan.name}" now exists where this change would create one. Resolve that conflict first.`;
    case "base_absent": return `The package "${plan.name}" this change was confirmed for is no longer installed, so there is nothing to change.`;
    case "base_moved": return `The package "${plan.name}" changed after it was confirmed. Prepare the change again and ask again.`;
    case "move_conflict": return `A package already exists where "${plan.name}" would be published. Resolve that conflict first.`;
  }
}

/** Rename the package the mutation replaces or moves into a hidden location
 *  inside its own store. The rename never leaves that store, so it cannot fail
 *  on a cross-device boundary, and a hidden package is not registry-visible. */
function hideOutgoing(manifest: OperationManifest): void {
  const outgoing = outgoingDirOf(manifest.plan.outcome);
  const store = dirname(outgoing);
  const hidden = rollbackDir(store, manifest.operationId);
  // Left by an earlier attempt. It can be the only copy of a package, so it is
  // preserved rather than overwritten.
  if (existsSync(hidden)) preserve(store, manifest.operationId, hidden);
  if (!existsSync(outgoing)) return;
  mkdirSync(dirname(hidden), { recursive: true });
  renameSync(outgoing, hidden);
  fsyncDirectory(dirname(outgoing));
  fsyncDirectory(dirname(hidden));
}

/** Publish the staged copy with one rename inside the destination store. */
function publish(globalRoot: string, manifest: OperationManifest): string | undefined {
  const plan = manifest.plan;
  const destination = plan.outcome.destination.dir;
  if (packageDigestAt(destination) === plan.outcome.package.identity.sha256) return undefined;
  if (existsSync(destination)) {
    return `A package appeared where "${plan.name}" would be published while the change was in flight. Resolve that conflict first.`;
  }
  const staging = stagingDir(globalRoot, manifest.operationId);
  if (packageDigestAt(staging) !== plan.outcome.package.identity.sha256) {
    return `The staged copy of "${plan.name}" is gone, so the change was rolled back. Ask again to apply it.`;
  }
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(staging, destination);
  fsyncDirectory(dirname(destination));
  return undefined;
}

/** Put the hidden package back where it came from, or preserve it when that
 *  location is occupied again. Returns where preserved bytes were left. */
function restoreOutgoing(manifest: OperationManifest): string | undefined {
  const outgoing = outgoingDirOf(manifest.plan.outcome);
  const store = dirname(outgoing);
  const hidden = rollbackDir(store, manifest.operationId);
  if (!existsSync(hidden)) return undefined;
  // The location was recreated while the operation was in flight. Renaming over
  // it would destroy whatever is there, and deleting the hidden copy would
  // destroy the bytes this operation moved, so neither happens.
  if (existsSync(outgoing)) return preserve(store, manifest.operationId, hidden);
  mkdirSync(dirname(outgoing), { recursive: true });
  renameSync(hidden, outgoing);
  fsyncDirectory(dirname(outgoing));
  return undefined;
}

/** Drop the working state of a published operation. The hidden copy is removed
 *  only once the destination provably holds the confirmed package; otherwise it
 *  is the only copy of it and is preserved instead. */
function complete(globalRoot: string, manifest: OperationManifest): string | undefined {
  const plan = manifest.plan;
  rmSync(stagingDir(globalRoot, manifest.operationId), { recursive: true, force: true });
  const outgoing = outgoingDirOf(plan.outcome);
  const store = dirname(outgoing);
  const hidden = rollbackDir(store, manifest.operationId);
  if (!existsSync(hidden)) return undefined;
  if (packageDigestAt(plan.outcome.destination.dir) === plan.outcome.package.identity.sha256) {
    rmSync(hidden, { recursive: true, force: true });
    return undefined;
  }
  const kept = preserve(store, manifest.operationId, hidden);
  return `the destination does not hold the confirmed package, so the copy it replaced is preserved at ${kept}`;
}

/** Move one directory into its store's quarantine area, where nothing reads it
 *  and nothing removes it. */
function preserve(storeDir: string, operationId: string, dir: string): string {
  const kept = quarantineDir(storeDir, `rollback-${operationId}-${Date.now()}`);
  mkdirSync(dirname(kept), { recursive: true });
  renameSync(dir, kept);
  fsyncDirectory(dirname(kept));
  log.warn("global skill operation preserved a package it could not restore", { operationId, kept });
  return kept;
}

/** Forget one operation completely: its manifest and any working state. Only a
 *  never-confirmed operation is dropped this way; a terminal one is retained
 *  evidence in its own area. */
export function forgetOperation(globalRoot: string, operationId: string): void {
  rmSync(stagingDir(globalRoot, operationId), { recursive: true, force: true });
  rmSync(manifestPath(globalRoot, operationId), { force: true });
}

/** Forget one proposal nobody confirmed. Nothing was staged for it, so the
 *  record is all there is. */
export function forgetProposal(globalRoot: string, proposalId: string): void {
  rmSync(proposalPath(globalRoot, proposalId), { force: true });
}
