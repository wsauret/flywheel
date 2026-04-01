import { describe, expect, it } from "bun:test";
import { shouldShowThinkingIndicator } from "../src/tui/components/thinking-indicator-state";

describe("shouldShowThinkingIndicator", () => {
  it("shows while the workflow is working without approval or questions", () => {
    expect(
      shouldShowThinkingIndicator({
        appState: "working",
        approvalPending: false,
        hasPendingQuestion: false,
        isInterrupted: false,
      }),
    ).toBe(true);
  });

  it("hides outside the working state", () => {
    expect(
      shouldShowThinkingIndicator({
        appState: "idle",
        approvalPending: false,
        hasPendingQuestion: false,
        isInterrupted: false,
      }),
    ).toBe(false);
  });

  it("hides while approval is pending", () => {
    expect(
      shouldShowThinkingIndicator({
        appState: "working",
        approvalPending: true,
        hasPendingQuestion: false,
        isInterrupted: false,
      }),
    ).toBe(false);
  });

  it("hides while a question prompt is active", () => {
    expect(
      shouldShowThinkingIndicator({
        appState: "working",
        approvalPending: false,
        hasPendingQuestion: true,
        isInterrupted: false,
      }),
    ).toBe(false);
  });

  it("hides while interrupted", () => {
    expect(
      shouldShowThinkingIndicator({
        appState: "working",
        approvalPending: false,
        hasPendingQuestion: false,
        isInterrupted: true,
      }),
    ).toBe(false);
  });
});
