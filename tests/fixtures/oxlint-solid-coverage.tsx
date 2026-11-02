// Permanent regression fixture for the oxlint + eslint-plugin-solid jsPlugin bridge.
// oxlint loads eslint-plugin-solid through its alpha JS-plugin bridge (oxlint.config.ts
// jsPlugins); this file proves that bridge still surfaces every recommended rule.
// Each block is a deliberate violation of exactly one recommended rule, named so a
// reader sees which rule id it targets. oxlint.config.ts scopes this file in (the
// tests/fixtures/oxlint-solid-*.tsx override), so oxlint exercises the full
// recommended rule set here. The regression test in
// tests/unit/oxlint-solid-bridge.test.ts runs oxlint over this file and asserts the
// rule ids fire. DO NOT "fix" these violations -- they are the test.
import { createSignal, createEffect } from "solid-js"
import { createStore } from "solid-js/store"

// solid/jsx-no-duplicate-props: same prop passed twice on one element.
export function JsxNoDuplicateProps() {
  return <div id="a" id="b" />
}

// solid/jsx-no-undef: component referenced in JSX is never defined or imported.
export function JsxNoUndef() {
  return <UndefinedComponent />
}

// solid/jsx-uses-vars: Imported is only used in JSX; the rule keeps it from being
// flagged unused. Violation = the import would wrongly read as unused without it.
import { Imported } from "./oxlint-solid-coverage-helper"
export function JsxUsesVars() {
  return <Imported />
}

// solid/no-unknown-namespaces: an unknown JSX namespace prefix.
export function NoUnknownNamespaces() {
  return <div unknown:thing="x" />
}

// solid/no-innerhtml: innerHTML attribute with non-static value.
export function NoInnerhtml(props: { html: string }) {
  return <div innerHTML={props.html} />
}

// solid/jsx-no-script-url: javascript: URL in an href.
export function JsxNoScriptUrl() {
  return <a href="javascript:alert(1)">link</a>
}

// solid/components-return-once: early return inside a component breaks run-once.
export function ComponentsReturnOnce(props: { ok: boolean }) {
  if (props.ok) return <div>ok</div>
  return <div>no</div>
}

// solid/no-destructure: destructuring props loses reactivity.
export function NoDestructure({ name }: { name: string }) {
  return <div>{name}</div>
}

// solid/prefer-for: .map() in JSX should be a <For> component.
export function PreferFor(props: { items: string[] }) {
  return <div>{props.items.map((item) => <span>{item}</span>)}</div>
}

// solid/reactivity: a signal read in createEffect via a value captured at setup
// time -- the classic untracked-read mistake. (Detectable without type info.)
export function Reactivity() {
  const [count, setCount] = createSignal(0)
  setCount(1)
  const stale = count()
  createEffect(() => {
  })
  return <button onClick={() => setCount(count() + 1)}>{count()}</button>
}

// solid/event-handlers: lowercase event handler name on a DOM element.
export function EventHandlers() {
  return <div onclick={() => {}}>click</div>
}

// solid/imports: a Solid store primitive imported from the wrong entry point.
import { reconcile } from "solid-js"
export function Imports() {
  const [s] = createStore({ a: 1 })
  return <div>{s.a + (reconcile ? 0 : 1)}</div>
}

// solid/no-react-deps: createEffect given a React-style dependency array.
export function NoReactDeps() {
  const [count] = createSignal(0)
  createEffect(() => count(), [count])
  return <div />
}

// solid/no-react-specific-props: className instead of class.
export function NoReactSpecificProps() {
  return <div className="x" />
}

// solid/self-closing-comp: empty element written with an explicit closing tag.
export function SelfClosingComp() {
  return <div></div>
}

// solid/style-prop: overridden OFF in oxlint.config.ts. A kebab-case style key would
// normally trip it; here it must NOT fire, proving the off-override holds.
export function StylePropOff() {
  return <div style={{ "background-color": "red" }}>x</div>
}

// Suppression-syntax probes. Both blocks are the exact reactivity violation from
// Reactivity() above; only the disable comment differs. oxlint honors BOTH the
// eslint-disable-next-line and oxlint-disable-next-line directives, so the existing
// eslint-disable comments in src/ keep suppressing through the bridge. The
// regression test asserts neither of these two lines reports solid(reactivity).
export function SuppressViaEslintDirective() {
  const [count, setCount] = createSignal(0)
  setCount(1)
  // eslint-disable-next-line solid/reactivity
  const stale = count()
  createEffect(() => {})
  return <div />
}

export function SuppressViaOxlintDirective() {
  const [count, setCount] = createSignal(0)
  setCount(1)
  // oxlint-disable-next-line solid/reactivity
  const stale = count()
  createEffect(() => {})
  return <div />
}
