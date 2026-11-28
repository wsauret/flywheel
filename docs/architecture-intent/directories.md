# Directories Architecture Intent

This file states how the account, project, and execution directory authorities divide Flywheel's state and path meaning, and how a project is selected.

## ARCH-DIRECTORIES-001: Three directory authorities own distinct state

The account data root owns account-global state, the project root owns one project's durable and definitional state, and the execution directory is only where tools and subprocesses operate and where relative paths get their meaning. The three never substitute for one another: a global path never infers a project, an execution directory never becomes project identity, and project-scoped state and mutations use the project root only. Project-relative inputs resolve from the project root, never from the process directory or the execution directory.

Because: A starting directory, a Git root, and a tool directory answer different questions, and conflating them fragments stores or sends tools to the wrong package.
Not: Using the starting directory or the Git root as an unconditional project identity.

## ARCH-DIRECTORIES-002: One owner resolves the account home

One owner resolves the account home from the process environment, else from the operating-system account record, and the account data root is the state directory in that home. Every account-global path derives from that one account home, including paths outside the account data root such as the shared agent-skills directory and the directory where the account service clones projects. Workers and subprocesses inherit the account home through the process environment, and no other module reads the home directory itself.

Because: A redirected home must move every account-global path together, and a second lookup splits account state.

## ARCH-DIRECTORIES-003: Project identity is selected once at the composition boundary

The composition root selects and canonicalizes the project root before any project-scoped log, store, configuration, registry, migration, worker, runtime, or client service starts. After that, the project root and the optional canonical repository root are injected values. No downstream consumer reads the project-root environment value, searches for a repository or a state directory, or derives project identity from the execution directory. The repository root keys repository-scoped services and is not a fourth directory authority.
Because: Repeated discovery can disagree with an explicit or interactive selection and lets a nested sandbox escape to an enclosing repository.
Not: Rediscovering the project at each consumer.

## ARCH-DIRECTORIES-004: The state directory is the only remembered project choice

The presence of the project state directory at a project root is the sole durable record that the directory was chosen as a project. Flywheel keeps no global binding, marker file, or project configuration field for project selection, because project selection is startup input, not project configuration.

Because: A project-configuration field is circular, since the project must be selected before its configuration loads, and any separate record must be kept in sync when state moves or is deleted.
Not: Persisting a separate project choice in a global binding, a marker, or project configuration.

## ARCH-DIRECTORIES-005: The state directory holds only accounted state

The project state directory never holds an entry that its state-generation retirement does not account for. Its exclusion from the project's version control therefore lives outside it, in the checkout's local exclude configuration, and that exclusion is best effort: a failure is logged and never fails a start.

Because: Generation cleanup refuses to discard a directory that holds unaccounted content, so a courtesy ignore file would wedge it.
Not: Placing a version-control ignore file inside the state directory.

## ARCH-DIRECTORIES-006: The execution owner records its directory

A chat or subagent records its canonical execution directory in its own session metadata, and a workflow run records it in its run settings. Workflow members read the run's directory through immutable membership and keep no copy. Runtime records carry the resolved directory only as a projection for their consumers, and session resource identities such as notes and scratch never change the execution directory.

## ARCH-DIRECTORIES-007: One use-time resolution gives paths their meaning

At each path-sensitive use, one resolver selects the owner's recorded execution directory, else the project root, and every use resolves paths against that one result. History, such as tool rendering and projections of the project store, uses the recorded directory whether or not it still exists. Live execution, resume, workers, and children that would start in a missing directory are refused with a message that names it, and the work never moves to another directory. Resolution never reads the current process directory, writes fallback metadata or a fact, or changes project identity.
Because: Where state is stored does not decide what a path means, and a fallback to the process directory would change what recorded relative paths mean after a restart.
Not: Letting resume adopt the current process directory.

## ARCH-DIRECTORIES-008: A child's directory derives from its immediate parent

A workflow or subagent launch inherits the launching agent's effective execution directory unless it names one. A relative selection resolves from that parent directory and an absolute one is accepted; either must name an existing directory and is canonicalized. An invalid selection is refused before the child is published or started.

## ARCH-DIRECTORIES-009: Clients display the directories the runtime resolved

The workspace snapshot carries the project root that the runtime opened, and every session row and session detail carries the execution directory that the runtime selected. A client displays those values from the protocol and never resolves a directory of its own.

Not: A client that computes a session's directory from its own working directory or configuration.

## ARCH-DIRECTORIES-010: A remote project keeps only terminal state locally

A terminal that opens a project on another machine selects no project on this machine. Its project root and execution directory are one directory under the account data root, keyed by the remote runtime and the project placement. That directory holds only the terminal's own state, such as its log, prompt history, and restore point.
Because: The project's store, sessions, and tools stay on the machine that serves it.

## ARCH-DIRECTORIES-011: Project identity is not execution containment

Selecting a project root controls only Flywheel-owned durable state and project context. It never limits the operating-system capabilities of tools in the execution directory, and no document or interface describes project-state isolation as process containment. Restricting process capabilities needs an external containment boundary.

Not: Treating the project root as a security sandbox.

## ARCH-DIRECTORIES-012: One contained-directory authority guards owned trees

One platform-neutral contained-directory authority owns all access to, and filesystem durability of, Flywheel-owned state, auth, package, and session trees and other untrusted owned trees. It validates one path component at a time and rejects links below the directory it opens. It never recurses through a linked target on deletion, and it bounds enumeration by depth, entries, resources, and bytes. It follows only a package link that a person placed in an external skill root, and opens its target as that package's contained directory (ARCH-BOUNDARIES-008). No write passes through the link. Callers never join paths or repeat link checks themselves.
Not: Path-based filesystem calls that create a second containment authority.

## ARCH-DIRECTORIES-013: Containment states each platform's real guarantee

On POSIX, owned-tree containment holds directory handles, operates relative to them without following links, and syncs files and their parent directories. On Windows, it holds resolved paths, rejects every reparse point, rechecks held directory identity, and syncs files only. It accepts a same-user check-to-use race and a bounded fallback when Windows refuses an operation for file sharing. No document or test claims parity.
Because: Windows exposes no handle-relative no-follow operations and no portable directory sync.

## ARCH-DIRECTORIES-014: Account-level override metadata does not own override content

The definition-override baseline manifest lives under the account data root so that one authority can reconcile physical overrides across projects. It records only reconciliation metadata; project override content stays under its project root and global override content stays in its global location.

## ARCH-DIRECTORIES-015: Benchmark trials keep state in the task workspace

A benchmark trial maps both the project root and the execution directory to the workspace that the benchmark harness supplies for that trial, and its settings, persistent processes included, come from the trial's Flywheel config. A trial never runs in the live checkout: its workspace holds a copy of the task's fixture source. That source is a pinned commit limited to an explicit list of paths, the files inside the task, or an empty tree. The trial's store is exported as evidence only after the headless host settles, and that export is a copy, not another durable authority.

## ARCH-DIRECTORIES-016: The agent that makes a worktree owns its lifecycle

A Git worktree changes execution placement only and never changes the directory authorities. The agent that creates or adopts a worktree owns its verification, durable publication, integration proof, and cleanup, and a child given the worktree owns only its assigned edits and verification. The owner removes the worktree before it hands off or reports, and never passes it to a parent or the person. Only a worktree that holds unpublished work stays, and the report says why. A worktree whose every change matches a published commit or the shared checkout is integrated.

Because: No lost diffs is stronger than unconditional removal.

## ARCH-DIRECTORIES-017: Definition override reconciliation has one authority per datum

Definition overrides reconcile against one authority per datum. A non-bundled definition is an override exactly when it sits at a bundled default's catalog location. Any other definition belongs to the user and is never reconciled. The bundled catalog is the sole authority for shipped defaults. One machine-owned manifest in the account data root is the sole authority for each override's acknowledged default identity. Every identity is a digest of exact file bytes. Conflict and staleness are derived by comparison and never persisted. An unreadable manifest is moved aside with a warning and rebuilt, never blocking a project from opening.
Not: Identity metadata inside override files, or a persisted conflict status field.

## ARCH-DIRECTORIES-018: A benchmark campaign records its source identity

A benchmark campaign records the identity of the Flywheel source that ran each candidate. Its own identity covers its tasks, persona guidance, judge, scoring contract, and trial isolation, but not the rest of the source, so a resume after an unrelated source change continues it. Its report names each source that ran cells. The identity detects a change of source; it does not prove which code one long-lived process loaded.

## ARCH-DIRECTORIES-019: Benchmark fixtures depend only on the public repository

A runnable benchmark fixture depends only on content in the public repository: a commit in its history, files inside the task, or an empty tree.

Because: A contributor runs the benchmarks from a public clone, and a commit that only the maintainer's object store holds makes the fixture fail there.
Not: Commits from before the public history, private folders, or snapshot archives outside the repository.

## ARCH-DIRECTORIES-020: Benchmark records are the public ledger of scored cells

Each benchmark campaign publishes one compact append-only record file in the public repository: every scored cell with its task identity, output, accounting, duration, and source, and each judge's absolute scores of it. It also holds each implementer cell that timed out, each other failed attempt, and each regrade of an implementer cell's stored diff by a changed task grader. Raw trial evidence stays on the machine that ran it. Rankings, rejudging, and regrading read only record files, so every clone reproduces them.

Because: A new model must take its place among stored results without a rerun of older settings.
Not: Publishing results folders, or keeping records private.

## ARCH-DIRECTORIES-021: A ranking pools records by task content and scoring contract

A benchmark ranking pools every recorded cell whose task content matches the current corpus and that one named judge scored under the current scoring contract. An implementer cell whose task changed only in grading pools through its grade by the current grader, never through the grade it recorded. It ranks a role on absolute per-cell measures only; pairwise preference stays in campaign reports. It reports every record it does not pool with the reason, and never drops one silently.

## ARCH-DIRECTORIES-022: A ranking reads one suite per role and counts a timeout as a failure

Each benchmarked persona ranks on one committed suite: its whole catalog corpus, unless the ranking names a narrower list. A cell of another task is reported as not pooled. A committed rule over pilot results commits each implementer task as ranked or floor. A task ranks only after an audit records each failure that separates settings as behavioral, not an unstated interface or a harness fault. Ranked tasks set quality, cost, and latency; floor tasks only check. A timed-out implementer cell ranks as a failed attempt at the time limit. Other failed attempts are listed to retry.

Because: A failure that a ranking leaves out flatters the setting that failed.
Not: Coverage against every catalog task, or a timed-out cell that is retried until it passes.

## ARCH-DIRECTORIES-023: Each benchmarked role has a results page generated from its records

Each benchmarked role has one committed results page generated from the record files alone: its rankings, every recorded cell by task and setting, per-setting totals, coverage gaps, and the campaigns behind it. Every command that appends records regenerates the pages it affects, and lint fails a page that differs from the records.

Because: Results that a reader must rebuild by hand from raw records are results nobody reads.
Not: A hand-maintained results table, which drifts from the records.

## ARCH-DIRECTORIES-024: An implementer cell scores the core checks of the change

Each hidden check of an implementer task is committed as core, serious, or edge. A cell's quality is the share of the task's new core and serious checks that pass, where each existing test the patch breaks adds one failed check. A passing existing test earns nothing. On a floor task, only failed core and serious checks count, as deductions. Edge checks are reported apart and never enter quality or the filters.

Because: A score that one missed edge case zeroes, or that unchanged tests inflate, ranks settings on test trivia instead of working code.
Not: One pass-or-fail grade per task, or the plain share of every test the task runs.

## ARCH-DIRECTORIES-025: A ranking states its confidence and names a default only on a held lead

A ranking states a 90% interval for each setting's quality and score, from resampled tasks and repeats, and the chance that each setting beats the next. It names one setting for a role only when that setting's quality lead holds at 90% confidence. Otherwise it names the best-scoring setting among those tied for the top quality.

Because: A default chosen on a gap that resampling reverses is a coin flip presented as evidence.
Not: Ordering every setting by its point score alone.

## ARCH-DIRECTORIES-026: An implementer cell carries a calibrated judged quality

An implementer cell also carries a judged quality score, from typed findings that a judge reports in its diff. A judge's score enters the ranking only after it passes committed calibration: seeded control defects and agreement with reviewer labels. Implementer quality is then the equal-weight mean of test quality and judged quality.

Because: Hidden tests cannot see needless code, wrong abstractions, or broken conventions, and an uncalibrated judge ranks on its own bias.
Not: A holistic score without stated findings.
