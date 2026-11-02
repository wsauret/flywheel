// Permanent regression fixture for the oxlint + eslint-plugin-solid jsPlugin bridge.
// A reactivity loss whose reactive source is a component prop typed as a Solid
// Accessor. eslint-plugin-solid is pure scope/AST analysis (it consults no type
// checker), yet it still flags this: every `props.x` access inside a component is
// treated as reactive by its scope heuristic, regardless of the prop's type. So
// solid/reactivity fires here through the same scope analysis -- not via the type.
// This fixture pins that the bridge surfaces a prop-derived reactivity loss; the
// regression test in tests/unit/oxlint-solid-bridge.test.ts asserts it. The match
// fires at warning severity (oxlint exits 0), so the test reads the JSON diagnostics
// rather than the exit code. DO NOT "fix" the violation -- it is the test.
import { createEffect, type Accessor } from "solid-js"

export function TypedReactivityLoss(props: { getValue: Accessor<number> }) {
  // props.getValue is read here and captured into a plain const, dropping reactive
  // tracking. solid/reactivity flags props.getValue as the reactive variable.
  const snapshot = props.getValue()
  createEffect(() => {
  })
  return <div>{snapshot}</div>
}
