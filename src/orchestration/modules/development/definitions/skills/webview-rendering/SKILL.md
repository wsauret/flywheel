---
description: Use when writing or reviewing a web client surface so it never flickers or moves the reader.
related: webview-uat
---

# Web Client Rendering

Input: the web client surface under change, the runtime publications that update it, and the reader's interactions with it. The desktop browser page, the phone, and the editor all mount the one SolidJS bundle under `webview/`, so a flicker here is a flicker on every surface.

PI-INTERACTION-062, PI-INTERACTION-098 states the behavior a person observes, ARCH-PROTOCOL-062 the surface ownership of UI state, and ARCH-PROTOCOL-063 the effect contract. These constraints apply to every change:

- Render a node one time, then update it in place. A row, a card, a label, or a paragraph keeps the same DOM node for as long as the thing it shows exists. A change of state changes attributes, classes, and text on that node; it never removes the node and inserts a new one. A remount is a flicker even when the new node looks the same, and the new node loses focus, the text selection, hover and press state, an open disclosure, a scroll anchor, and any live subscription.
- The scroll position belongs to the reader. When content above the reader changes, the row that the reader looks at stays at the same place on the screen.
- Never hide a remount or a jump. Do not add a CSS transition, a fade, or an animation to a row. Do not debounce or throttle publications: the update must be cheap and in place, not rare. Do not delay rendering with `setTimeout`, `queueMicrotask`, or a "loaded" flag that shows content one frame late.
- Ordinary reconnection never replaces the client; ARCH-PROTOCOL-030 owns client replacement.

## Method

1. List each node that a live update reaches and the publication that reaches it: an equal object republished, a token, a state change, a page of older history, a recovery.
2. Check the surface against the ten rules. Read `references/rules.md` for the incorrect and correct example of each rule and the test that guards it.
   1. One element per row, and its tag never changes with state.
   2. Key lists by stable identity: `Key` for rows with an id, `Index` when position is the identity, `For` only for items whose object identity is stable.
   3. Know which `Show`, `Switch`, and inline JSX conditions remount.
   4. Subscribe to a narrow slice, not to a whole object.
   5. Patch rendered Markdown and HTML in place.
   6. Reserve layout for content that comes and goes.
   7. Keep the reader's row in place when older history is prepended.
   8. On iOS, hold a prepended page until the scroll is still.
   9. Remember disclosure state by stable identity.
   10. Connection state never decides whether a surface exists.
3. Write one identity test for each UI that updates live, before you fix or add the component. Use the memory host in `webview/src/app/render-ownership-host-fixture.ts`. It runs the real Solid components through `solid-js/universal`, without a browser, and lets a test compare node identity.
   1. Add a mount function to `webview/src/app/render-ownership-fixture.ts`. Create the component inside `createRoot`, feed its props from a signal, and return `dispose`, a setter that publishes a new value, and readers for the nodes you check. Export it from `webview/src/app/render-ownership-loader-fixture.ts` if you use that fixture. A module surface keeps its mount function in its module home, such as `mountWorkflowActivity` in `webview/src/modules/workflows/activity-fixture.tsx` or the workflow screens in `webview/src/modules/workflows/stability-fixture.tsx`.
   2. Mount, keep a reference to each node that must stay, publish an update that the real runtime sends, and assert that the same node is still there.
   3. Assert the visible change too, so that the test fails when the update did not apply.
   4. For a scroll owner, drive the viewport that the fixture returns: set `scrollTop`, call its `onScroll`, `dispatch` touch events, and call `frame()` to run the pending animation frame. `webview/src/app/transcript-window-ownership.test.ts` shows each step.

   ```ts
   test("a queued row keeps its node when its agent starts", () => {
     const mounted = mountWorkflowActivity(block)
     try {
       const row = mounted.elements().find(node => String(node.properties.class).includes("workflow-card-agent"))
       assert.ok(row)
       mounted.setBlock({ ...block, card: card(true) })
       assert.ok(mounted.elements().includes(row), "starting the agent must not replace its row")
       assert.match(String(row.properties.class), /state-running/)
     } finally { mounted.dispose() }
   })
   ```

   Run one file with `bun run test ./webview/src/app/render-continuity.test.ts`.
4. Check a grid track change in a browser. The memory DOM cannot lay out, so measure the column edges before and after the live change.

## Debugging a flicker

1. Find the node that remounts. In the browser developer tools, run this in the console, then reproduce the flicker:

   ```js
   new MutationObserver((records) => {
     for (const record of records) for (const node of record.removedNodes) console.log("removed", node, "from", record.target)
   }).observe(document.querySelector(".transcript"), { childList: true, subtree: true })
   ```

   An update in place shows no removed nodes, because text and attribute changes are `characterData` and `attributes` records. Each logged node is a remount. Change the selector to observe another surface.
2. Confirm with one element. Select it in the Elements panel, run `const probe = $0` in the console, reproduce the update, then run `probe.isConnected`. `false` means that the element was replaced. A DOM breakpoint on the parent with "Break on subtree modifications" stops at the code that removes it.
3. Find the cause in the component that owns the removed node. Look for the patterns of rules 1 to 5: a `Show` or `Switch` that swaps elements, a `keyed` `Show`, a `<For>` over published objects, an effect that reads more than its key, an inline JSX condition that changes, or a reset of `innerHTML`.
4. For a jump without a removed node, turn on "Layout Shift Regions" in the Chrome Rendering panel. A shift on update means a missing reservation (rule 6). A shift when older history loads means a missing or stale anchor (rules 7 and 8).
5. Write the failing identity test (step 3 of the method), then fix the component.

Stop when every node that a live update reaches keeps its identity in an identity test that also asserts the visible change, and every layout change you made is measured in a browser. Return the surfaces and rules checked, the tests added or extended with their commands and results, and any browser measurement. Use `webview-uat` for an acceptance criterion on the live client.
