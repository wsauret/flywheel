/**
 * Soft-keyboard inset math for the phone host.
 *
 * When the on-screen keyboard opens, iOS does not shrink the shell: the
 * keyboard overlays it, and a composer pinned to the bottom of a full-height
 * shell ends up underneath it. The reliable signal is `window.visualViewport`,
 * whose `height` shrinks to the visible region above the keyboard. The
 * keyboard inset is the part of the shell the visual viewport does not show:
 *
 *   inset = shellHeight - vv.height
 *
 * The host applies it as bottom padding on the client's root, which lifts the
 * composer above the keyboard, and pins the page scroll to the top, because
 * iOS otherwise scrolls the shell to reveal the focused field and drags the
 * header off screen. `interactive-widget=resizes-content` in the viewport
 * meta makes Android Chrome resize the layout viewport itself, where the
 * inset computes to about 0 and this path is a no-op.
 */

/**
 * Insets smaller than this are treated as 0. Collapsing browser chrome (URL
 * bar show and hide) produces small transient height deltas that would
 * otherwise thrash the layout; real soft keyboards are at least about 150px.
 */
const KEYBOARD_INSET_MIN_PX = 80;

export interface ViewportGeometry {
  /** `visualViewport.height`: visible height above the keyboard. */
  height: number;
}

/**
 * Height (px) of the shell currently obscured by the soft keyboard, or 0 when
 * no keyboard is showing / the signal is unusable. `shellHeightPx` is the
 * rendered height of the client's root, not `window.innerHeight`: in an
 * installed iOS app the root is sized to the screen while the layout viewport
 * reads shorter, and the keyboard covers the root.
 */
export function computeKeyboardInset(
  viewport: ViewportGeometry | null | undefined,
  shellHeightPx: number,
): number {
  if (!viewport || !Number.isFinite(shellHeightPx) || shellHeightPx <= 0) {
    return 0;
  }
  const { height } = viewport;
  if (!Number.isFinite(height)) return 0;
  const inset = Math.round(shellHeightPx - height);
  return inset >= KEYBOARD_INSET_MIN_PX ? inset : 0;
}

/** The shape of `document.activeElement` this decision reads. */
export interface FocusedElement {
  tagName: string;
  isContentEditable: boolean;
  /** An input's `type`; absent on any other element. */
  type?: string;
}

/** Input types that never raise a soft keyboard. */
const KEYLESS_INPUT_TYPES = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);

/**
 * Whether a soft keyboard can be showing at all: only while an editable
 * element has focus. iOS does not always deliver a final `visualViewport`
 * resize once the keyboard has finished hiding, so a measurement taken during
 * the hide animation would otherwise stand as the inset until the next
 * event, leaving the composer floating above an empty band. Focus is the
 * signal the keyboard cannot outlive.
 */
export function keyboardMayBeOpen(active: FocusedElement | null | undefined): boolean {
  if (!active) return false;
  if (active.isContentEditable) return true;
  const tag = active.tagName.toUpperCase();
  if (tag === "TEXTAREA") return true;
  return tag === "INPUT" && !KEYLESS_INPUT_TYPES.has((active.type ?? "text").toLowerCase());
}

/**
 * Whether this page runs as an app installed from Safari. iOS marks one with
 * `navigator.standalone`; the `display-mode: standalone` media query stays
 * false there on iOS 26, so it cannot be the signal.
 */
export function isIosInstalledApp(nav: { readonly standalone?: unknown }): boolean {
  return nav.standalone === true;
}

/** A position on the screen, in CSS pixels. */
export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Movement past this between touchstart and touchend makes a touch a drag.
 * iOS focuses a field only on a tap, so a drag that ends on one must not.
 */
const TAP_SLOP_PX = 10;

/** Whether a touch from `start` to `end` is a tap rather than a drag. */
export function isTap(start: ScreenPoint, end: ScreenPoint): boolean {
  return Math.hypot(end.x - start.x, end.y - start.y) <= TAP_SLOP_PX;
}

/** A vertical span on the screen, in CSS pixels. */
export interface ScreenSpan {
  readonly top: number;
  readonly bottom: number;
}

/** Space kept between a revealed field and the edge of what can be seen. */
const REVEAL_MARGIN_PX = 12;

/**
 * How far a scroller must scroll, in CSS pixels, to show `field` inside
 * `visible`: positive scrolls the content up, negative scrolls it down, and 0
 * leaves a field that is already in view. A field taller than the visible
 * span shows its top, where the caret of an empty field sits.
 */
export function revealDelta(field: ScreenSpan, visible: ScreenSpan): number {
  const top = visible.top + REVEAL_MARGIN_PX;
  const bottom = visible.bottom - REVEAL_MARGIN_PX;
  if (field.top < top || field.bottom - field.top > bottom - top) return field.top - top;
  if (field.bottom > bottom) return field.bottom - bottom;
  return 0;
}

/**
 * Whether the page scroll should be pinned back to the top.
 *
 * The client's shell is a fixed full-height column and must never scroll, but
 * iOS Safari scrolls the page when a focused input would sit under the
 * keyboard, which drags the header under the status bar. Pin whenever a
 * keyboard is present so the shell stays put; the transcript's own scrolling
 * handles content visibility.
 */
export function shouldPinScroll(nextInsetPx: number): boolean {
  return nextInsetPx > 0;
}
