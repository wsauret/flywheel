# Web Client Render Continuity Rules

Each rule gives an incorrect and a correct example and names the tests that guard it. Unqualified test file names are under `webview/src/app/`.

## 1. One element per row, and its tag never changes with state

Give each row one element for its whole life. Do not choose the tag from state. A queued workflow phase cannot be opened, but it is still a `<button>`: it is disabled with `aria-disabled` and `tabindex`, and its click handler checks the state.

Incorrect. The row is a `<div>` while it is queued and a `<button>` when it starts, so `Show` removes one element and inserts the other:

```tsx
<Show when={opens()} fallback={<div class={`workflow-card-phase state-${props.line.state}`}>{content()}</div>}>
  <button type="button" class={`workflow-card-phase state-${props.line.state}`} onClick={(event) => props.act(event, props.line)}>{content()}</button>
</Show>
```

Correct, from `webview/src/modules/workflows/card.tsx`:

```tsx
<button type="button" class={`workflow-card-phase state-${props.line.state}`}
  aria-disabled={!opens() || undefined} tabindex={opens() ? 0 : -1}
  onClick={(event) => { if (opens()) props.act(event, props.line) }}>{content()}</button>
```

The stylesheet reads the state from the attribute, not from the tag:

```css
button:is(.workflow-card-phase, .workflow-card-agent)[aria-disabled="true"] { cursor: inherit; }
button:is(.workflow-card-phase, .workflow-card-agent):not([aria-disabled="true"]):hover { background: var(--fw-list-hover); }
```

The same rule applies to a row whose kind is fixed by its key. In `webview/src/app/transcript.tsx` each keyed row computes `run()`, `block()`, and `turn()`, and only one of them is ever defined for that key, so the branch that mounts never flips.

Guards: "a queued workflow phase retains its row and cells when its agent starts" in `render-continuity.test.ts`, and "the full-size card's phases and agents keep DOM identity across equal replacements" in `stability.test.ts`.

## 2. Key lists by stable identity

Pick the list primitive from what identifies an item:

- `<Key each={...} by={...}>` from `@solid-primitives/keyed` keys items by an identity function. Use it for rows that have an id: transcript rows, local submissions, and session notices.
- `<Index each={...}>` keys items by position. Use it when the position is the identity, such as the parts of one label. Each child gets an accessor and updates in place.
- `<For each={...}>` keys items by object reference. The client receives new objects on each publication, even when the values are equal, so `<For>` over published data rebuilds every row on every update. Use it only for items whose object identity is stable.

Incorrect. The header parts are a new array of new objects on each token count, so every part remounts:

```tsx
<For each={parts()}>
  {(part, index) => <span class={`tone-${part.tone}`}>{index() > 0 ? " · " : ""}{part.text}</span>}
</For>
```

Correct, after `webview/src/modules/workflows/activity.tsx`:

```tsx
<Index each={parts()}>
  {(part, index) => <span class={`tone-${part().tone}`}>{index > 0 ? " · " : ""}{part().text}</span>}
</Index>
```

Correct, from `webview/src/app/transcript.tsx`. The rows are keyed by `rowIdentity`, not by reference:

```tsx
<Key each={rows()} by={rowIdentity}>
  {(row, index) => <div class="row" data-block={rowIdentity(row())}>...</div>}
</Key>
```

A key must also survive paging and recovery. A tool group renders under the key of the block that opened its stretch. `createWebTranscript` in `webview/src/client/tool-runs.ts` keeps that key when older calls arrive or recovery changes coordinates. Its owner lives in the resident `SessionMemory` (`webview/src/client/session-residents.ts`), alongside `createTurnFolds`. Returning to a resident session resumes that presentation. A coordinate revision never starts a new presentation lifetime.

Guards: "workflow summary publications keep their live subscription and label nodes" in `render-continuity.test.ts`, "a growing tool stretch retains its wrapper and preview nodes through completed-call gaps" in `tool-stretch-ownership.test.ts`, "session notices keep DOM identity across equal frame replacements" in `stability.test.ts`, and "a group keeps the key it rendered under as older calls of its stretch arrive" in `webview/src/client/tool-runs.test.ts`.

## 3. Know which `Show` patterns remount

In Solid 1.9, a `Show` without `keyed` mounts its children again only when `when` changes from truthy to falsy or back. When the children are a function, they get an accessor to the current value, and the content updates in place. A `Show` with `keyed` mounts its children again each time the `when` value changes identity.

These patterns remount:

- `<Show when={value()} keyed>` where `value()` is a new object on each publication.
- A `Show` whose `when` flips between truthy and falsy as state changes.
- A `Show` with a `fallback` that is a different element from its children. This is rule 1.
- A `Switch` whose matched `Match` changes.
- An inline JSX condition, such as `{frame().done ? <Done /> : <Running />}`, when the condition changes. The compiler memoizes the condition, so an equal value keeps the branch, but a change of `done` replaces it. Use one element whose class or text follows the value when both branches show the same thing.

Incorrect. Each publication of the card is a new object, so the card remounts on every update:

```tsx
<Show when={card()} keyed>{(shown) => <WorkflowCard card={shown} />}</Show>
```

Correct. The card mounts once and reads the current value through the accessor:

```tsx
<Show when={card()}>{(shown) => <WorkflowCard card={shown()} />}</Show>
```

Use `keyed` only when a remount is the intent. The transcript does this for the activity status, so that a session switch starts it again: `<Show when={state().sessionId} keyed>`.

## 4. Subscribe to a narrow slice, not to a whole object

An effect runs again when any signal it reads changes. If the effect opens a subscription, each run closes the old subscription and opens a new one, and the live content goes blank between them. Derive the narrow key in a memo, and let the effect depend only on that memo. When the subscription also takes a demand that can change, update the open subscription from a nested effect instead of opening a new one.

Incorrect. The effect reads the whole block, so a token count update on the block closes and opens the live subscription:

```tsx
createEffect(() => {
  const id = parseWorkflowLink(block()?.linkUri)?.workflowId
  if (id !== undefined) onCleanup(client.subscribe(id, setReading, surface()))
})
```

Correct, from `webview/src/modules/workflows/activity.tsx`. The memo changes only when the watched workflow changes, and a change of demand updates the open subscription:

```tsx
const workflowId = createMemo(() => parseWorkflowLink(block()?.linkUri)?.workflowId)
createEffect(on(workflowId, id => {
  if (id === undefined) return
  const subscription = client.subscribe(id, setReading, untrack(surface))
  onCleanup(subscription)
  createEffect(on(surface, demand => subscription.update(demand), { defer: true }))
}))
```

The same rule applies to a frame that the client publishes many times a second. `Transcript` in `webview/src/app/transcript.tsx` does not let rows read the frame. It writes each slice into its own signal inside one `batch`, and gives a composite slice an `equals` function. A signal written with an equal value notifies nobody, so a publication reaches only the rows whose input changed:

```tsx
const [shown, setShown] = createSignal<PresentedWindow>({ blocks: [], start: null, hasBefore: false }, {
  equals: (a, b) => a.blocks === b.blocks && a.start === b.start && a.hasBefore === b.hasBefore,
})
const presentFrame = (frame: ClientViewState, window: PresentedWindow) => batch(() => {
  setShown(window)
  setBodies(frame.bodies)
  setGroups(frame.groups)
})
```

Guard: "workflow summary publications keep their live subscription and label nodes" in `render-continuity.test.ts`. It counts subscriptions and releases across token updates.

## 5. Patch rendered Markdown and HTML in place

Streaming Markdown grows on each token. Do not remove the live tail and insert new HTML. Parse the new HTML into a detached `<template>`, then patch the resident nodes with `patchMarkdownChildren` from `webview/src/app/markdown-dom.ts`. The patcher keeps an equal node, sets `nodeValue` on a text node, updates the attributes of an element with the same tag and patches its children, and replaces a node only when its node type or tag changed.

Incorrect. Each token removes the tail paragraph and inserts a new one:

```ts
while (element.childNodes.length > settledNodes) element.lastChild?.remove()
element.insertAdjacentHTML("beforeend", step.tailHtml)
```

Correct, from `webview/src/app/markdown-view.tsx`:

```ts
settled.innerHTML = step.settledHtml
tail.innerHTML = step.tailHtml
const settledCount = settled.content.childNodes.length
patchMarkdownChildren(element, [...settled.content.childNodes, ...tail.content.childNodes], settledNodes)
settledNodes += settledCount
```

Guards: "Markdown retains its parsed nodes across equal publications and live text growth" and "Markdown retains nested elements and text while patching hand-built DOM trees" in `render-continuity.test.ts`.

## 6. Reserve layout for content that comes and goes

A line, a time, or a count that appears or disappears must not move the rows the reader sees. Give it its space from the first frame:

- Hide with `visibility: hidden`, which keeps the space, not with `display: none` or a `Show`, which remove it. The row time in `webview/src/styles/blocks.css` (`.row-meta.inline-time`) and the columns that a phone drops from the full-size card in `webview/src/styles/workflow-card.css` work this way.
- Give changing numbers `font-variant-numeric: tabular-nums`, so that a clock or a counter does not change width as it counts.
- Size no grid track from live content. `fit-content`, `max-content`, `min-content`, and `auto` tracks resize when any line in the grid changes, so an agent line that comes or goes, chits that appear, or a time that gains a digit moves a column in every line. The inline workflow card in `webview/src/styles/workflow-card.css` gives each track a width that does not depend on content, and a head longer than its track ellipsizes.
- Give a label that can grow a fixed height. The plan bar label uses `max-height: 1lh; overflow: hidden`.
- Give a card its final height from its first frame. Only the progress of the run and the choices of the person change the number of lines of a workflow card (PI-INTERACTION-051).

Incorrect:

```tsx
<Show when={hovered()}><span class="row-meta">{time()}</span></Show>
```

Correct:

```tsx
<span class="row-meta inline-time">{time()}</span>
```

```css
.row-meta.inline-time { visibility: hidden; font-variant-numeric: tabular-nums; }
```

A notice that can repeat keeps one stable row. Session notices are keyed by their runtime scope in `webview/src/app/session-notices.tsx`, so a "Chat startup failed" notice that the runtime publishes again keeps its row instead of being removed and added.

## 7. Keep the reader's row in place when older history is prepended

When the reader scrolls near the top, the transcript asks for an older page. The page inserts rows above the reader. Without a correction, the browser keeps `scrollTop`, and the content under the reader moves down by the height of the page.

`createOlderPageScroll` in `webview/src/app/transcript-scroll.ts` owns this correction:

1. `load()` records the first row that reaches into the viewport, its top, the row ids, and `scrollTop`, then requests the page.
2. While the page is pending, `onScroll` replaces the recorded anchor with the row that the reader is on now. A reader who scrolls during the load keeps the new position, not the old one.
3. `reconcile()` runs after the mutation. If rows were prepended, it finds the anchor row again (or the nearest surviving row through `survivingReaderAnchor`) and scrolls by the distance it moved, with `preserveReaderAnchor(scrollTop, currentTop, anchorTop)`, which returns `scrollTop + currentTop - anchorTop`. The scroll uses `behavior: "instant"`.

Rules for any scroll owner:

- Read the presented window, not a newer store frame. `Transcript` keeps one `shown()` snapshot, and restoring, anchoring, paging, and the saved reading place all read it.
- Measure only what you need. `viewport.rows()` is a generator, and `firstVisibleReaderAnchor` stops at the first visible row, so a scroll event does not measure every row.
- Page back only on a reader gesture. A scroll event that the pin to the tail causes must not page history in.
- A restore of a saved reading place asks for the next older page only after the previous page has rendered (`createReadingRestore`).

Guards: "moves a prepended page above the reader instead of leaving the load trigger active", "holds one paging operation through tail output and restores after a regrouped prepend", and "reads a restore's older pages back only as each page renders" in `reader-expansion-scroll.test.ts`.

## 8. On iOS, hold a prepended page until the scroll is still

On iOS, a scroll by a finger, by momentum, or by the bounce past the top owns the scroll position. It paints its next frame over a compensating `scrollTo`, so the reader sees the oldest rows for one frame. The correction in rule 7 cannot win against it.

`Transcript` therefore admits a prepended page in two steps. `admit()` finds the held edge by block identity, not its previous coordinates. It shows the new frame without the prepended rows, so the rows already on screen keep updating live. This also applies when recovery rebases the window to disjoint coordinates. `landWhenStill()` waits for an animation frame that no scroll event and no touch preceded, and with `scrollTop` not below zero, and then shows the whole window. The coordinates, rows, and anchor correction paint together.

```ts
const landWhenStill = () => {
  scrolled = false
  settling = requestAnimationFrame(() => {
    settling = undefined
    if (touching || scrolled || (scroller?.scrollTop ?? 0) < 0) landWhenStill()
    else {
      const frame = untrack(state)
      presentFrame(frame, wholeWindow(frame))
    }
  })
}
```

Do not use a timer for this wait. A timer guesses how long the scroll lasts; the animation frame check observes it.

Guards: "holds its rows for a still animation frame past the bounce, a finger, and scrolling, while the rows on screen stay live" and "a restore reads the rows on screen, not a page that waits for a still frame" in `transcript-window-ownership.test.ts`.

## 9. Remember disclosure state by stable identity

An open fold, tool group, or file must stay open through paging, a replaced window, and a reload. Store the choice of the person by a stable key, and make it absolute: `createBlockDisclosure` in `webview/src/app/block-disclosure.ts` stores `{ open, chosen }`, so a close is a choice too and holds against how a row arrives.

- A cold load or reload can render a tool group under a different key. Recovery of a resident session keeps its existing key. `ToolGroupBlock` finds the saved choice under any key the group answers to, with `disclosure.chosenKey(sessionId, toolGroupKeys(group))`.
- A one-call stretch keeps its wrapper and header when it settles into the call's ordinary presentation. `createToolPresentation` supplies the same labels, actions, notices, and body as an ordinary tool. The stretch's choice key owns disclosure and file facets before and after settlement. The first call's keyed content owner stays mounted when a second call arrives. Running one-call commands retain Stop or Detach beside the stretch header. An explicitly opened body stays mounted; only the untouched preview disappears. `tool-stretch-ownership.test.ts` checks open, close, growth, command controls, file, and read capabilities.
- A turn that the reader was already inside when an older page brings its person message arrives as an open fold, so rows the reader has seen do not fold away (`createTurnFolds` in `webview/src/client/turn-folds.ts`).
- Local choices belong to the session and the stable identity of the thing shown, not to a window read or a component mount. `createQuestionInteractions` in `webview/src/app/question-panel.tsx` keeps question disclosure, picks, and drafts by session and `toolUseId`, so a session switch and return restores them.

Incorrect. The choice is stored under a key that changes when the window keys the stretch again, and only open choices are kept:

```ts
const open = () => props.disclosure.state(props.sessionId, props.group.id)().open
```

Correct, from `webview/src/app/tool-group.tsx`:

```ts
const choiceKey = createMemo(() => props.disclosure.chosenKey(props.sessionId, toolGroupKeys(props.group)) ?? props.group.id)
const open = () => props.disclosure.state(props.sessionId, choiceKey())().open
```

Guards: the tests under "a window that opened inside a turn" and "an opened tool stretch" in `transcript-window-ownership.test.ts`, and "the choices of a session are the rows and files the reader opened or closed there, and restore as they were" in `block-disclosure.test.ts`.

## 10. Connection state never decides whether a surface exists

A surface mounts from the identity of the thing it shows, never from connection health or whether a window is current. A reconnect, recovery, or re-read patches the resident surface in place. While the client cannot trust its data, disable the actions that need current data on their existing nodes. Remove the surface only when current data proves that the thing it shows no longer exists.

The question dock in `webview/src/app/composer.tsx` mounts by session and the newest unanswered question's `toolUseId`. A non-current window holds its Answer and Skip actions, not its form. A slash command hides the dock without disposing it. Question rows use the question text, which also keys their answers, and choice rows use their stable option ids. Attention expands the dock only on a new request, with `on(..., { defer: true })`, never from the request already present at mount.

Guard: "the mounted question dock keeps its nodes and local choices through recovery" in `render-continuity.test.ts`, including attention present at mount. It checks the dock and choice-row identity, minimized state, picks, drafts, held actions, slash entry, and return to the session.

App mounts the rail, its resizer, the phone session screen, and a selected docked workspace from the held project identity and the person's layout choices. Provider expiry and offline or dormant placement reports do not remove those owners. Before the first project snapshot, runtime and loading stages fill the pane, except for waiting messages: a reload or a reopened tab that took over messages its predecessor had not delivered opens their chat at once, and the chat shows them queued instead of the loading screen. Once the project is known, the same stages are advisory content inside the pane. They do not make the resident conversation inert or move its focus. The machine list of a known project shows only with the connection's fault notice, so a presence report alone, such as during a short freeze of the machine, changes nothing on screen. Send admission still checks provider and runtime readiness.

The Composer holds submission on its resident Send button while those stages need a runtime or provider. Click and Enter keep the unsent draft until admission returns. Remote placement labels retain the selected machine and project through missing presence reports, but never cross an explicit selection change. Client-wide notices such as the Home Screen install guide stay visible for a known project through availability changes, so the session list keeps its geometry and reading position.

Guards: `app-readiness.test.ts` checks the real App through provider loss and restoration, phone placement changes with and without a connection fault, cold loading, and a cold load that shows restored waiting messages. `sheets/status-sheet-runtime.test.tsx` keeps one focused Runtime button through every health state. Its callback stays present, while `aria-disabled` and activation use current eligibility.
