# Why this task exists

This task ports `bench/tasks/implement/template-multiphase` into the chat A/B campaign. The source adapts the template-engine persona fixture into three dependent phases. The agent must discover implementation details, complete a nested template engine, and verify its public behavior. There are no planted traps.

## Provenance and sandbox

The sandbox archives only `.gitignore` from commit `64d9b75aeaa02fb5d00d2f75d01ea8a50df0d743`, following the debug-mutable-default precedent. The additive `sandbox.patch` reproduces all four source `project/` files byte for byte. No dependency installation or setup command is needed. The sandbox contains no plan, qualification patches, manifest, or acceptance tests before capture.

The hidden template suite is copied unchanged from the source acceptance directory. The five original visible tests are also frozen under `acceptance/literal-guards.test.ts`, with only their relative imports adjusted. The campaign copies these tests after capturing the agent's diff, so edits to visible tests cannot remove the guards.

## What the checks prove

Thirty fail-to-pass checks cover the public error message, exact token offsets, literal spans, substitutions, escaping, raw values, dot paths, truthiness, array iteration, item-only scope, lazy bodies, nesting, and structural error positions. Five pass-to-pass guards preserve literal rendering, empty templates, whitespace, literal token positions, and the existing error export. These counts come from the current JUnit output, not the older source narrative.

The suite accepts both the source recursive evaluator and its iterative work-stack alternative. It does not require a parser filename, a private representation, or one rendering algorithm. Source qualification mutants remain rejected: dropping literals fails five checks, unescaped values fail two, and leaked parent scope fails one. Original phase-order and delegation judgments are not converted into source-text tests; the design message supplies the requested process while acceptance scores final behavior.

## Design variant

`message.md` is a short request without the plan. `design.md` reveals the truthful three-phase approach: adjust the public error prefix, build tokenization and structural parsing, then integrate rendering. It states token and error position semantics, escaping rules, item-only scope, lazy bodies, public API preservation, and phase verification gates. It reveals no filenames, source code, reference implementation, or hidden test identifiers.

## Verification evidence

On 2026-10-22, a one-off verification script, run with `bun --env-file=.env.test`, ran the real `provisionSandbox` and `captureSandbox` functions. Every workspace was inside this repository's session scratch directory. The script checked exact source-project bytes and an empty baseline diff before acceptance.

The unfixed sandbox returned acceptance exit 1: 30 failures and five passes across 35 tests. Applying the original `qualification/reference.patch` returned exit 0: all 35 acceptance tests passed, with all five visible tests passing separately. Applying the source alternative also passed all 35 acceptance tests and five visible tests. All three source mutants failed their expected behavioral checks. The verification script exited 0 and disposed every sandbox and command home.

The script recorded per-test outcomes, commands, and captured-diff metadata. The recorded capture confirms that frozen acceptance files are absent from the submitted diff. No reference solution ships in this task directory.
