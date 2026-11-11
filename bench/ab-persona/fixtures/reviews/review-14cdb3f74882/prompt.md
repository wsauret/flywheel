Review an uncommitted change in .. Do not edit project files.

Files to diff:
- scripts/uat/tmux-driver.ts
- scripts/uat/tui.ts
- tests/helpers/real-process-fixture.ts
- tests/integration/local/real-process-fixture.test.ts
- tests/integration/scripts/uat/harness.test.ts
- tests/integration/scripts/uat/lifecycle.test.ts
- tests/unit/helpers/real-process-fixture.test.ts (new)

In scripts/uat/harness.ts and tests/unit/scripts/uat/harness.test.ts, review only these hunks:
- the RELEASE_HARNESS_ENVIRONMENT import and spread
- removeUatHome
- the attachApp(sessionName, home) call sites
- the "sweeps the sandbox after the app pane has exited" test

The auth-profile hunks belong to an already reviewed unit. Many other files in the tree belong to unrelated work, so ignore them.

## Design intent (fixed)
- Both harnesses own the processes they start by sandbox directory identity: the UAT tmux harness, and the real-process test fixture that the perf and release gates use.
- Teardown always ends detached services before it deletes their HOME.
- Teardown never kills an unrelated process whose path only shares a string prefix. The original Windows bug: gate home `<ws>\gate` matched `<ws>\gate3.ps1`.
- Every repository-owned Bun process launch states windowsHide: true.
- Windows process-tree and job-object behavior is load-bearing.
- Never kill the person's real Flywheel service or any process outside the sandbox.
- It works on macOS, Linux, and Windows.

## Implementation
- namesDirectory() requires a path-segment boundary and accepts both separators. Drive letters compare without case.
- harnessProcesses(root) requires the release-harness marker plus root named in the environment or the command line. On Windows, the environment comes from the new windowsTable(), through windowsProcessApi().environment(pid), with a command-line fallback.
- The stop function rereads the table after each kill round, checks identity before each kill, and throws if anything survives.
- removeUatHome deletes HOME only after a successful stop.
- `keys`: when the pane exits, it prints "App pane exited" and exits 0.

## Check
1. Correctness of the matcher on edge cases: trailing separators, `root` equal to a parent of another root, UNC paths, and mixed case on POSIX, where case must matter.
2. Kill safety. A PID reused between read and kill must not cause a kill outside the sandbox. A process that lacks the marker must never be killed.
3. The Windows fallback rule ("command line names root") must not reintroduce the prefix bug.
4. Run the change natively on Windows with the windows-ssh skill, in a new isolated remote temp directory that you remove afterward. Do not touch the person's Windows installation. Exercise the real tests/helpers/real-process-fixture.ts discovery: start a marked process under `<dir>\gate` and a marked process whose path is `<dir>\gate3.ps1`, then show that harnessProcesses and stop affect only the first. Bundling with `bun build` and copying over scp, as earlier probes did, is fine.

Locally, run `bun --conditions=browser test tests/unit/helpers/real-process-fixture.test.ts tests/unit/scripts/uat/harness.test.ts tests/integration/local/real-process-fixture.test.ts tests/integration/scripts/uat/harness.test.ts tests/integration/scripts/uat/lifecycle.test.ts`.

Report only confirmed findings, each with path:line, evidence, and a scenario. Also report the Windows probe result.