---
name: Ship
description: Publish completed repository work through commits and pushes.
delegate: ship
---

# Ship Changes

Publish the selected files without losing existing edits.

## Input and preflight

Start with the files to publish and a short summary of user intent and implemented design. For a pull request, the caller can also supply its account of what changed from the approved design, the proof that the change works, and what that proof does not cover. Use this method directly or through the Ship subagent. In direct use, take these inputs from the work already completed in the current conversation. In delegated use, take them from the caller's handoff. Neither route needs a prepared commit message.

Verification and review precede publication. This method does not request verification evidence, assess it, or repeat those checks. Integration of newer remote work still happens here. The caller repeats its narrow verification for selected files that integration changes.

{{if:bash}}
Use `commit + push` to the current branch's normal push target by default. Extra publication instructions are needed only for a user-requested pull request or nondefault destination. Do not ask the user to select the default mode.

Before branch or index mutation:

1. Inspect Git status and the selected files' diffs, including staged changes and untracked files. The supplied file list defines scope; do not discover a different unit from intent or add other paths.
2. Commit each selected file's complete current contents, including edits from other agents. Same-file overlap is expected and is not a blocker. Do not reconstruct authorship, partially stage files, split the supplied group, or create worktrees to isolate edits.
3. Leave uncommitted edits outside the supplied list untouched; only commits that integration brings in change those files. Never reset, restore, stash, clean, reconstruct, or auto-format files, and never use `--autostash`. Preserve pre-existing staged changes outside the list without including them in this commit.
4. Preflight Bash, Git, current branch, remote, credentials, and push target. Check pull-request tooling only for a requested PR. Work in the current execution directory. Integration and cleanup of an existing worktree remain its owner's responsibility.
5. Fetch the push target. Newer remote work, including commits that change selected files, is integrated after the commit, as Publish describes. It is never a reason to stop or a separate catch-up task.

Missing Bash, Git, credentials, or a push target blocks before mutation. Report a selected path with no remaining change rather than inventing work for it.

## Commit

{{ref:commit-contract}}

Write one logical commit message from the intent and design summary plus the selected diffs. The supplied whole-file group is the publication unit, including concurrent edits. The commit contract's grouping rule does not authorize splitting, regrouping, or rejecting that group. Follow repository-specific message rules when present. Run the repository commit validator when available. Never add assistant attribution or co-author lines.

## Publish

Commit on the checked-out branch. When HEAD lacks the fetched push-target tip, integrate it with a plain `git merge <push target>`. Resolve each conflict in the committed files so that both sides' intent survives, and record the selected files that integration changed. When Git refuses because the merge would overwrite an uncommitted file outside the list, leave that file untouched: create a temporary worktree detached at the new commit, run the same merge there, push from it, and remove it. The new commit stays an ancestor of the push target, and the uncommitted file's owner resolves its own overlap when it commits.

Push `HEAD` by branch name; require remote evidence before claiming publication. Never build a commit with plumbing such as `commit-tree`, `read-tree`, `merge-tree`, or `update-ref`, and never push a commit id. The fallback's merge in a detached worktree is the only commit made off the branch, and it pushes as `HEAD:<branch>`. A rejected push is a stop, not a cue to construct a different commit.

After a successful push, use `git worktree list` to find each local checkout of the pushed branch, including the current one after a temporary-worktree push. Bring it to the new remote tip with `git merge --ff-only`. When Git refuses, leave that checkout untouched and report it.

In `branch + PR` mode, create the feature branch before staging when the current branch is a base branch. Discover the actual base. Create or update a pull request whose description explains context, decisions, constraints, validation, and review guidance that the diff cannot show. When the caller supplied that account, put it in the description verbatim; it is the caller's account, so do not assess, edit, or verify it. Do not restate the file inventory or invent rationale.

Missing or unauthenticated pull-request tooling can leave a successful branch, commit, and push intact, but report the pull request as unavailable. A push failure preserves the commit and reports the exact recovery command; never force-push without explicit approval.
{{else}}
Without a shell, this method cannot inspect Git, commit, or push. Change nothing and report the work as not published, with the missing shell as the condition that stopped publication.
{{end}}

## Stop and result

Stop after successful push in commit mode or pull-request publication in PR mode, including the destination checkout update. Report final branch, commit and committed paths, push state, pull request URL or state when applicable, and the exact recovery command where needed. Name selected files that integration changed so the caller repeats its narrow verification. The caller fixes forward and does not revert integrated work. Never claim publication without remote evidence.