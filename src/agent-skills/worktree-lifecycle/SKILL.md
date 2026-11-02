---
description: Use when creating or adopting a Git worktree.
related: ship
---

# Worktree Lifecycle

A worktree is temporary isolation, not disposable work. Preserve ownership, destination, and every diff until integration is proved.

## Input and ownership

Start with create or adopt action, canonical path, branch or base, intended destination, integration method, and owner. Record these before mutation. Require Bash and Git before mutation, use a stable sibling path, and never overwrite existing work or place a worktree in disposable session storage.

## Method

1. Create or adopt the worktree and keep its ownership record current. Create a new worktree from a freshly fetched destination tip. In a new worktree, install dependencies from the lockfile before the first gate. Post the full absolute path of the worktree to the user as soon as it exists, so that they can open it in a file explorer and inspect its files and diffs.
2. Keep work durable through commits or an explicit handoff before the owner exits.
3. After a rebase with conflicts, compare the old and new commits with `git range-diff` and confirm that each change from the destination side in the conflicted files survives.
4. Before final verification, fetch the destination and rebase onto its tip. When the base changed, run the gates again, because verification on the old base does not cover the rebased tree.
5. When publication is required, dispatch `ship` once without forked history in the existing worktree. Send the files to publish and a short summary of user intent and implemented design. Add a destination only when it differs from the normal push target. Keep integration and cleanup ownership in the parent, consume Ship's publication evidence, then resume destination integration and cleanup. When the parent's integration advances the remote destination, bring that branch's local checkout to the new tip with `git merge --ff-only`; when Git refuses, leave that checkout untouched.
6. Consume fresh verification evidence. Run only lifecycle-specific clean-state and destination-containment proofs here.
7. Prove ancestry where applicable with `git merge-base --is-ancestor <commit> <destination>`.
8. Remove only the owned worktree after integration proof and a clean safety check, using `git worktree remove <path>` without force.

## Stop and result

Stop after safe cleanup or a durable handoff that transfers explicit ownership. Report the full absolute path, branch, owner, destination, publication or handoff state, integration proof, cleanup state, and remaining action.

## Failure and recovery

Missing Bash or Git blocks before mutation. Any uncommitted work, uncertain owner, publication failure, or missing integration proof preserves the worktree and branch. Never force removal, reset, stash, clean, or use checkout-based recovery. After restart, rediscover the path, branch, and commit, then resume the first incomplete lifecycle step.