// Build-time patches against vendored dependencies.
//
// Why a patcher instead of `bun patch`:
// - bun's `patchedDependencies` keys the patch by exact `<pkg>@<version>`.
//   A minor bump (or republish with a different bundle hash) silently drops
//   the patch — `bun update` doesn't warn that no longer-matching patch exists.
// - `@opentui/core` ships its bundle under a content-hashed filename
//   (e.g. `index-691sybgy.js`); a literal patch file fails the moment the
//   hash rotates.
//
// This script does string substitution, scoped to the targets we care about,
// with a strict precondition check. Runs as `postinstall` (every `bun install`)
// and at the start of `build-binary.ts`. If the precondition stops matching —
// upstream changed the call shape or, ideally, finally exposed `breaks` — the
// script fails loud and the patch becomes obviously stale.

import { Glob } from "bun";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

type Patch = {
  name: string;
  glob: string;
  find: string;
  replace: string;
  expectedOccurrences: number;
};

const patches: Patch[] = [{
  // OSC 4 support does not establish OSC 10/11 support. Some terminals report
  // foreground/background colors without an ANSI palette.
  name: "preserve terminal special colors without ANSI palette support",
  glob: "node_modules/@opentui/core/chunk-*.js",
  find: `    const supported = await this.detectOSCSupport();
    if (!supported) {
      return {
        palette: Array(size).fill(null),
        defaultForeground: null,
        defaultBackground: null,
        cursorColor: null,
        mouseForeground: null,
        mouseBackground: null,
        tekForeground: null,
        tekBackground: null,
        highlightBackground: null,
        highlightForeground: null
      };
    }
    const indicesToQuery = [...Array(size).keys()];
    const idleTimeout = env2.OTUI_PALETTE_IDLE_TIMEOUT_MS;
    const [paletteResults, specialColors] = await Promise.all([
      this.queryPalette(indicesToQuery, timeout, idleTimeout),
      this.querySpecialColors(timeout, idleTimeout)
    ]);`,
  replace: `    const indicesToQuery = [...Array(size).keys()];
    const idleTimeout = env2.OTUI_PALETTE_IDLE_TIMEOUT_MS;
    const [paletteResults, specialColors] = await Promise.all([
      this.detectOSCSupport().then((supported) => supported ? this.queryPalette(indicesToQuery, timeout, idleTimeout) : new Map()),
      this.querySpecialColors(timeout, idleTimeout)
    ]);`,
  expectedOccurrences: 1,
}, {
  // A mouse selection runs in reading order from its anchor to its focus, so
  // every row between them is selected from edge to edge. OpenTUI culls the
  // renderables it notifies to the rectangle between the two points, which
  // skips a table cell or a nested box whose columns lie right of the drag's
  // end, so that text is neither highlighted nor copied. Cull by rows only and
  // let each renderable decide from its own local selection which cells it
  // holds.
  name: "notify every renderable on the selected rows",
  glob: "node_modules/@opentui/core/chunk-*.js",
  find: `  walkSelectableRenderables(container, selectionBounds, selectedRenderables, touchedRenderables) {
    const children = getObjectsInViewport(selectionBounds, container.getChildrenSortedByPrimaryAxis(), container.primaryAxis, 0, 0);`,
  replace: `  walkSelectableRenderables(container, selectionBounds, selectedRenderables, touchedRenderables) {
    const selectedRows = { x: -Number.MAX_SAFE_INTEGER / 2, y: selectionBounds.y, width: Number.MAX_SAFE_INTEGER, height: selectionBounds.height };
    const children = getObjectsInViewport(selectedRows, container.getChildrenSortedByPrimaryAxis(), container.primaryAxis, 0, 0);`,
  expectedOccurrences: 1,
}, {
  // In reading order, a point left of a renderable's first column is the start
  // of that row. OpenTUI's native text selection drops the whole selection when
  // its later point has a negative local column, so a drag that ends in the
  // block gutter, or left of an indented blockquote, copied nothing from that
  // text. Clamp both points to column 0, which names the same position.
  name: "clamp a selection point left of a renderable to its first column",
  glob: "node_modules/@opentui/core/chunk-*.js",
  find: `    anchorX: globalSelection.anchor.x - localX,
    anchorY: globalSelection.anchor.y - localY,
    focusX: globalSelection.focus.x - localX,`,
  replace: `    anchorX: Math.max(0, globalSelection.anchor.x - localX),
    anchorY: globalSelection.anchor.y - localY,
    focusX: Math.max(0, globalSelection.focus.x - localX),`,
  expectedOccurrences: 1,
}, {
  // A frame excludes the captured source from the hit grid, so release can
  // hit its ancestor. That ancestor already received mouse-up by bubbling
  // from the source; keep the drop event without sending a second mouse-up.
  name: "send mouse-up once when a drag releases over its source ancestor",
  glob: "node_modules/@opentui/core/chunk-*.js",
  find: `      if (maybeRenderable) {
        this.sendMouseEvent(maybeRenderable, new MouseEvent2(maybeRenderable, { ...mouseEvent, type: "drop", source }));
      }`,
  replace: `      if (maybeRenderable) {
        this.sendMouseEvent(maybeRenderable, new MouseEvent2(maybeRenderable, { ...mouseEvent, type: "drop", source }));
        if (this.isWithinContainer(source, maybeRenderable))
          return true;
      }`,
  expectedOccurrences: 1,
}, {
  // A scroll box's content has a minimum width of 100%, so its row overflows
  // by the scrollbar's width. With the default flexShrink of 1, Yoga shrinks
  // the scrollbar and the content in proportion, both get fractional widths,
  // and every text in the content rounds one column wider than its box. Text
  // then wraps and draws one column past its box background.
  name: "keep a scrollbar at its own width",
  glob: "node_modules/@opentui/core/index.*.js",
  find: `  constructor(ctx, { trackOptions, arrowOptions, orientation, showArrows = false, ...options }) {
    super(ctx, {
      flexDirection: orientation === "vertical" ? "column" : "row",
      alignSelf: "stretch",
      alignItems: "stretch",
      ...options`,
  replace: `  constructor(ctx, { trackOptions, arrowOptions, orientation, showArrows = false, ...options }) {
    super(ctx, {
      flexDirection: orientation === "vertical" ? "column" : "row",
      alignSelf: "stretch",
      alignItems: "stretch",
      flexShrink: 0,
      ...options`,
  expectedOccurrences: 1,
}, {
  // After each frame OpenTUI hit-tests the still pointer again but tells the
  // leaf under it nothing when that leaf is unchanged. A hover that covers only
  // part of its leaf, such as a text's drawn glyphs, then goes stale when the
  // content scrolls or changes under the pointer. Send that leaf a move, but
  // not while the left button is held: a press handler such as a tab drag
  // reads every move, so each frame would schedule the next one.
  name: "send a move to the unchanged hover leaf after a frame",
  glob: "node_modules/@opentui/core/chunk-*.js",
  find: `    if (lastOver?.num === hitId) {
      this.lastOverRenderableNum = hitId;
      return;
    }`,
  replace: `    if (lastOver?.num === hitId) {
      this.lastOverRenderableNum = hitId;
      if (!this.pressedRenderable)
        this.sendMouseEvent(lastOver, new MouseEvent2(lastOver, { type: "move", button: 0, x: this._latestPointer.x, y: this._latestPointer.y, modifiers: this._lastPointerModifiers }));
      return;
    }`,
  expectedOccurrences: 1,
}, {
  // Miniflare starts temporary-directory removal without waiting for it, so
  // dispose can leave entries behind when the test runner checks its temp root.
  // Keep its existing ignored-error policy, but wait for removal to settle.
  name: "wait for Miniflare temporary-directory removal during disposal",
  glob: "node_modules/miniflare/dist/src/index.js",
  find: `    removeDir(this.#tmpPath, { fireAndForget: true });`,
  replace: `    await removeDir(this.#tmpPath).catch(() => {
    });`,
  expectedOccurrences: 1,
}];

let exitCode = 0;
const alreadyApplied = new Set<string>();

for (const patch of patches) {
  const glob = new Glob(patch.glob);
  let appliedSites = 0;
  let candidateFiles = 0;

  for await (const relPath of glob.scan({ cwd: ROOT, onlyFiles: true })) {
    candidateFiles++;
    const absPath = join(ROOT, relPath);
    const original = await readFile(absPath, "utf-8");

    const occurrences = original.split(patch.find).length - 1;
    const alreadyPatched = original.includes(patch.replace);

    // This bundle chunk doesn't contain the target code — opentui ships its
    // build split across multiple `index-*.js` chunks. Skip silently.
    if (occurrences === 0 && !alreadyPatched) continue;

    if (alreadyPatched && occurrences === 0) {
      alreadyApplied.add(patch.name);
      appliedSites++;
      continue;
    }

    if (occurrences !== patch.expectedOccurrences) {
      console.error(
        `  ✗ ${patch.name} — precondition failed in ${relPath}: ` +
          `expected ${patch.expectedOccurrences} occurrence(s) of \`${patch.find}\`, ` +
          `found ${occurrences}. Upstream likely changed; update scripts/patch-deps.ts.`,
      );
      exitCode = 1;
      continue;
    }

    const updated = original.split(patch.find).join(patch.replace);
    await writeFile(absPath, updated);
    console.log(`  ✓ ${patch.name} — patched ${relPath} (${occurrences} site${occurrences === 1 ? "" : "s"})`);
    appliedSites += occurrences;
  }

  if (candidateFiles === 0) {
    console.error(`  ✗ ${patch.name} — no files matched ${patch.glob}. Dependency missing or renamed.`);
    exitCode = 1;
  } else if (appliedSites === 0) {
    console.error(`  ✗ ${patch.name} — scanned ${candidateFiles} file(s) but found no \`${patch.find}\` to patch. Upstream likely fixed this; remove the entry.`);
    exitCode = 1;
  }
}

// This script runs on every install and again before every build, so steady
// state is one line; only a patch that changed a file is named.
if (alreadyApplied.size > 0) {
  console.log(`  ✓ ${alreadyApplied.size} dependency patch(es) already applied`);
}

if (exitCode !== 0) {
  console.error("\nDependency patches failed. Resolve before building or shipping.");
  process.exit(exitCode);
}
