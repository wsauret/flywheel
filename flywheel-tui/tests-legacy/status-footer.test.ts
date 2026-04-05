import { describe, it, expect } from "bun:test";
import { resolveFooterShortcuts, type FooterContext } from "../src/tui/utils/footer-shortcuts";

// ---------------------------------------------------------------------------
// VAL-TUI-014: Status footer shows queue shortcuts during working
// ---------------------------------------------------------------------------
describe("resolveFooterShortcuts — working state (VAL-TUI-014)", () => {
  it("shows Esc shortcut during working state", () => {
    const ctx: FooterContext = { appState: "working" };
    const text = resolveFooterShortcuts(ctx);
    expect(text).toContain("Esc");
  });

  it("shows navigate shortcut during working state", () => {
    const ctx: FooterContext = { appState: "working" };
    const text = resolveFooterShortcuts(ctx);
    expect(text).toContain("Navigate");
  });

  it("shows Stop hint during working state", () => {
    const ctx: FooterContext = { appState: "working" };
    const text = resolveFooterShortcuts(ctx);
    expect(text).toContain("Stop");
  });

  it("shows sidebar hint when sidebar is visible during working", () => {
    const ctx: FooterContext = { appState: "working", sidebarVisible: true };
    const text = resolveFooterShortcuts(ctx);
    expect(text).toContain("Tab");
    expect(text).toContain("Sidebar");
  });

  it("omits sidebar hint when sidebar not visible during working", () => {
    const ctx: FooterContext = { appState: "working", sidebarVisible: false };
    const text = resolveFooterShortcuts(ctx);
    expect(text).not.toContain("Sidebar");
  });

  it("shows approval-pending shortcuts when approval pending during working", () => {
    const ctx: FooterContext = { appState: "working", approvalPending: true };
    const text = resolveFooterShortcuts(ctx);
    expect(text).toContain("Focus Prompt");
  });
});

// ---------------------------------------------------------------------------
// Status footer — idle/completed state
// ---------------------------------------------------------------------------
describe("resolveFooterShortcuts — idle/completed state", () => {
  it("shows standard shortcuts during idle", () => {
    const ctx: FooterContext = { appState: "idle" };
    const text = resolveFooterShortcuts(ctx);
    expect(text).toContain("Esc");
  });

  it("shows standard shortcuts during completed", () => {
    const ctx: FooterContext = { appState: "completed" };
    const text = resolveFooterShortcuts(ctx);
    expect(text).toContain("Esc");
  });

  it("shows resume hint when session is resumable", () => {
    const ctx: FooterContext = { appState: "completed", isSessionResumable: true };
    const text = resolveFooterShortcuts(ctx);
    expect(text).toContain("Resume");
  });

  it("omits resume hint when session is not resumable", () => {
    const ctx: FooterContext = { appState: "completed", isSessionResumable: false };
    const text = resolveFooterShortcuts(ctx);
    expect(text).not.toContain("Resume");
  });
});

// ---------------------------------------------------------------------------
// Status footer — sidebar focused overrides
// ---------------------------------------------------------------------------
describe("resolveFooterShortcuts — sidebar focused", () => {
  it("shows sidebar navigation shortcuts when sidebar focused", () => {
    const ctx: FooterContext = { appState: "working", sidebarFocused: true };
    const text = resolveFooterShortcuts(ctx);
    expect(text).toContain("Navigate");
    expect(text).toContain("Select");
    expect(text).toContain("Exit Sidebar");
  });
});

// ---------------------------------------------------------------------------
// Status footer — prompt focused overrides
// ---------------------------------------------------------------------------
describe("resolveFooterShortcuts — prompt focused", () => {
  it("shows prompt shortcuts when prompt focused", () => {
    const ctx: FooterContext = { appState: "working", isPromptFocused: true };
    const text = resolveFooterShortcuts(ctx);
    expect(text).toContain("Exit Prompt");
    expect(text).toContain("Enter");
    expect(text).toContain("Skip");
  });
});
