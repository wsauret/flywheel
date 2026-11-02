import { describe, expect, it } from "bun:test";
import {
  computeKeyboardInset,
  isIosInstalledApp,
  isTap,
  keyboardMayBeOpen,
  revealDelta,
  shouldPinScroll,
} from "./keyboard-inset.js";

describe("isIosInstalledApp", () => {
  it("reads navigator.standalone, which only an installed iOS app sets true", () => {
    expect(isIosInstalledApp({ standalone: true })).toBe(true);
    expect(isIosInstalledApp({ standalone: false })).toBe(false);
    expect(isIosInstalledApp({})).toBe(false);
    expect(isIosInstalledApp({ standalone: "yes" })).toBe(false);
  });
});

describe("keyboardMayBeOpen", () => {
  it("is false with nothing focused, so a stale inset cannot survive a dismissed keyboard", () => {
    expect(keyboardMayBeOpen(null)).toBe(false);
    expect(keyboardMayBeOpen(undefined)).toBe(false);
    expect(keyboardMayBeOpen({ tagName: "BODY", isContentEditable: false })).toBe(false);
    expect(keyboardMayBeOpen({ tagName: "BUTTON", isContentEditable: false })).toBe(false);
  });

  it("is true for the composer and any text-like input", () => {
    expect(keyboardMayBeOpen({ tagName: "TEXTAREA", isContentEditable: false })).toBe(true);
    expect(keyboardMayBeOpen({ tagName: "INPUT", isContentEditable: false, type: "text" })).toBe(true);
    expect(keyboardMayBeOpen({ tagName: "INPUT", isContentEditable: false, type: "search" })).toBe(true);
    expect(keyboardMayBeOpen({ tagName: "input", isContentEditable: false })).toBe(true);
    expect(keyboardMayBeOpen({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("is false for inputs that raise no keyboard", () => {
    expect(keyboardMayBeOpen({ tagName: "INPUT", isContentEditable: false, type: "checkbox" })).toBe(false);
    expect(keyboardMayBeOpen({ tagName: "INPUT", isContentEditable: false, type: "range" })).toBe(false);
    expect(keyboardMayBeOpen({ tagName: "INPUT", isContentEditable: false, type: "file" })).toBe(false);
  });
});

describe("computeKeyboardInset", () => {
  it("returns 0 when visualViewport is unavailable", () => {
    expect(computeKeyboardInset(null, 800)).toBe(0);
    expect(computeKeyboardInset(undefined, 800)).toBe(0);
  });

  it("measures against the shell, not the layout viewport", () => {
    // Installed iOS app on an iPhone 17 Pro: the shell is the 874px screen while
    // the layout viewport reads 812; the keyboard leaves 471px visible.
    expect(computeKeyboardInset({ height: 471 }, 874)).toBe(403);
  });

  it("ignores small deltas from collapsing browser chrome", () => {
    // URL bar show/hide produces deltas well under a real keyboard height.
    // The smallest inset that reads as a keyboard rather than a browser bar is 80px.
    const delta = 80 - 1;
    expect(
      computeKeyboardInset({ height: 800 - delta }, 800),
    ).toBe(0);
  });

  it("accepts insets at exactly the threshold", () => {
    expect(
      computeKeyboardInset(
        { height: 800 - 80 },
        800,
      ),
    ).toBe(80);
  });

  it("never goes negative when vv is larger than layout height", () => {
    // Rotation / zoom races can transiently report vv.height > innerHeight.
    expect(computeKeyboardInset({ height: 900 }, 800)).toBe(0);
  });

  it("returns 0 for degenerate layout heights", () => {
    expect(computeKeyboardInset({ height: 480 }, 0)).toBe(0);
    expect(computeKeyboardInset({ height: 480 }, -1)).toBe(0);
    expect(computeKeyboardInset({ height: 480 }, Number.NaN)).toBe(0);
  });

  it("returns 0 for non-finite viewport values", () => {
    expect(computeKeyboardInset({ height: Number.NaN }, 800)).toBe(0);
  });

  it("rounds fractional geometry to whole pixels", () => {
    // iOS reports fractional vv heights under pinch zoom.
    expect(computeKeyboardInset({ height: 479.6 }, 800)).toBe(320);
  });
});

describe("isTap", () => {
  it("is a tap while the finger stays within 10px of where it went down", () => {
    expect(isTap({ x: 200, y: 761 }, { x: 200, y: 761 })).toBe(true);
    expect(isTap({ x: 200, y: 761 }, { x: 206, y: 769 })).toBe(true);
  });

  it("is a drag past 10px, which must not focus the field it ends on", () => {
    expect(isTap({ x: 200, y: 761 }, { x: 200, y: 772 })).toBe(false);
    expect(isTap({ x: 200, y: 500 }, { x: 200, y: 761 })).toBe(false);
  });
});

describe("revealDelta", () => {
  // A list from y 0 to the keyboard top at y 471.
  const visible = { top: 0, bottom: 471 };

  it("leaves a field that is already in view", () => {
    expect(revealDelta({ top: 300, bottom: 344 }, visible)).toBe(0);
  });

  it("scrolls a field the keyboard covers up to just above the keyboard", () => {
    expect(revealDelta({ top: 680, bottom: 724 }, visible)).toBe(724 - 459);
  });

  it("scrolls a field above the visible span down into it", () => {
    expect(revealDelta({ top: -100, bottom: -56 }, visible)).toBe(-112);
  });

  it("shows the top of a field taller than the visible span", () => {
    expect(revealDelta({ top: 200, bottom: 800 }, visible)).toBe(188);
  });
});

describe("shouldPinScroll", () => {
  it("pins while a keyboard inset is active", () => {
    expect(shouldPinScroll(320)).toBe(true);
  });

  it("does not pin without a keyboard", () => {
    expect(shouldPinScroll(0)).toBe(false);
  });
});
