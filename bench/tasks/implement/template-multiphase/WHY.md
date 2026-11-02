# Why this task exists

This medium fixture was written to measure the orchestration judgment of the removed implement-step harness, not only the correctness of template code. It adapts the truthful `template-engine` persona fixture (removed; see git history) into three phases with deliberately different work sizes.

Current use: the persona benchmark runs the implementer persona directly on this task, with no parent orchestration, and grades it on the hidden acceptance suite. The task has no traps. The phase and judgment-point text below describes the removed harness, in which a parent had to choose proportionate execution, preserve phase order, and use each verification command as a real gate. It is kept as the history of the task design.

The project retains the source fixture's typed token model, literal-only renderer, public import surfaces, and hidden acceptance suite. The only baseline test addition constructs `TemplateError` through its public export. This gives the tiny first phase a visible seam while keeping the unmodified project green.

## Phase purpose

1. **template-error-message** changes one line in one file. It exists to expose wasteful delegation. The parent has enough context to make and verify this edit directly.
2. **tokenizer-and-parser** adds the largest body of logic. Token scanning, exact offsets, a nested representation, stack matching, and positional errors form one cohesive substantial unit. The phase also requires visible parser-boundary tests so its verification cannot pass on the original literal tokenizer alone.
3. **renderer-integration** resolves paths, escapes values, applies scoped `if` and `each` semantics, and connects the prior phase to the public renderer. This is moderate integration work after the structural foundation exists.

There are no traps. The plan is truthful, and a correct implementation can follow it in order.

## Judgment point purpose (historical)

The removed implement-step harness scored these points from the parent transcript and telemetry. The current harness does not score them.

1. **delegation-trivial-phase** catches a subagent dispatch whose entire useful result is a four-line-or-smaller phase diff while the parent does no concurrent work. The dispatch scope, returned diff, parent transcript, and telemetry make this observable.
2. **delegation-substantial-phase** permits either defensible strategy. A focused dispatch satisfies it. Inline work also satisfies it when the first phase verification passes and no repair dispatch is needed.
3. **phase-verification-gates** distinguishes real orchestration from final-only testing. The transcript must place the same runnable command after each phase and before the next phase starts.
4. **phase-ordering** protects the dependency sequence without forbidding evidence-based adaptation. Any changed order needs a repository or verification result in the transcript.
5. **orchestrator-integration-review** requires the parent to verify the combined implementation instead of accepting subagent completion claims as proof.

All judgment criteria were checkable from the diff, parent transcript, and telemetry. No score depended on an unobservable intent or on a preferred delegation style.

## Verification evidence

- `bun validate-fixtures.ts` in the session scratchpad decoded this plan through the registered real `plan-handoff` Effect schema, ran its registered validators, parsed every manifest point, and loaded both fixtures through the implement-task loader. Exit code 0.
- `bun test render.test.ts` in a temporary copy of the unmodified project passed 5 tests and 7 assertions. Exit code 0.
- `bun test acceptance` in that temporary unmodified copy failed all 27 hidden tests, as required. Exit code 1.
- A reference implementation existed only in the session scratchpad. `bun test acceptance` against it passed 27 tests and 32 assertions. Exit code 0.

The reference implementation and temporary copies are not shipped with the fixture.
