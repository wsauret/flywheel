import { REGISTERED_REDUCERS } from "../../../../workflows/reducers/registry.js"

/** `flywheel workflow reducers`: print every registered reducer as
 *  `<id>@<version>` with the parameters that a phase's `join.with` gives it,
 *  so a person can see what a phase's `join.reducer` accepts. */
export function runWorkflowReducers(): void {
  process.stdout.write(`${workflowReducerLines().join("\n")}\n`)
}

export function workflowReducerLines(): readonly string[] {
  return REGISTERED_REDUCERS.flatMap(({ id, version, parameters }) => parameters.length === 0
    ? [`${id}@${version}: no parameters`]
    : [`${id}@${version}:`, ...parameters.map(({ name, optional, description }) => `  ${name}${optional ? " (optional)" : ""}: ${description}`)])
}
