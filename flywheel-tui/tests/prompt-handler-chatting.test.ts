import { describe, it, expect, mock } from "bun:test";
import { createPromptHandler, type PromptHandlerDeps, type ToastLike } from "../src/tui/shell/prompt-handler";
import type { AppState } from "../src/tui/shell/shell-modes";

/**
 * Prompt Handler — Chatting State Tests
 *
 * Verifies prompt input routing in the 'chatting' AppState:
 *   - Bare text calls sendChatMessage
 *   - Slash commands route through the action dispatcher
 *   - Empty input is ignored
 *   - Unknown slash commands show toast error
 */

function createMockDeps(overrides: Partial<PromptHandlerDeps> = {}): PromptHandlerDeps {
  const toastShow = mock(() => {});
  const toast: ToastLike = { show: toastShow as ToastLike["show"] };

  return {
    appState: () => "chatting" as AppState,
    workState: () => null,
    isSessionResumable: () => false,
    viewedSessionId: () => null,
    isInterrupted: () => false,
    activeStore: () => null,
    isQueueRunning: () => false,
    activeStdinHandleRef: { current: null },
    pendingInjection: { current: null },
    getActiveSession: () => null,
    getDepsOrWarn: () => null,
    toast,
    resumeSession: mock(() => {}),
    resumeWorkerWithMessage: mock(() => {}),
    sendChatMessage: mock(() => {}),
    dispatch: mock(() => ({ stepLabel: "test", workflowName: "test" })),
    setActiveStepLabel: mock(() => {}),
    setActiveWorkflowName: mock(() => {}),
    ...overrides,
  };
}

describe("prompt handler in chatting state", () => {
  it("routes bare text to sendChatMessage", () => {
    const sendChatMessage = mock(() => {});
    const deps = createMockDeps({ sendChatMessage });
    const { handlePromptInput } = createPromptHandler(deps);

    handlePromptInput("hello world");

    expect(sendChatMessage).toHaveBeenCalledTimes(1);
    expect(sendChatMessage).toHaveBeenCalledWith("hello world");
  });

  it("routes slash commands through the action dispatcher", () => {
    const dispatch = mock(() => ({ stepLabel: "Plan", workflowName: "start" }));
    const deps = createMockDeps({ dispatch });
    const { handlePromptInput } = createPromptHandler(deps);

    handlePromptInput("/start build a widget");

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith("start", expect.objectContaining({}));
    expect(deps.sendChatMessage).not.toHaveBeenCalled();
  });

  it("ignores empty input", () => {
    const sendChatMessage = mock(() => {});
    const deps = createMockDeps({ sendChatMessage });
    const { handlePromptInput } = createPromptHandler(deps);

    handlePromptInput("");
    handlePromptInput("   ");

    expect(sendChatMessage).not.toHaveBeenCalled();
  });

  it("shows error toast for unknown slash commands", () => {
    const toastShow = mock(() => {});
    const toast: ToastLike = { show: toastShow as ToastLike["show"] };
    const deps = createMockDeps({ toast });
    const { handlePromptInput } = createPromptHandler(deps);

    handlePromptInput("/unknown-command");

    expect(toastShow).toHaveBeenCalledTimes(1);
    expect(toastShow).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Unknown command"),
        variant: "error",
      })
    );
    expect(deps.sendChatMessage).not.toHaveBeenCalled();
  });

  it("does not call sendChatMessage when it is undefined", () => {
    const deps = createMockDeps({ sendChatMessage: undefined });
    const { handlePromptInput } = createPromptHandler(deps);

    // Should not throw even when sendChatMessage is undefined
    expect(() => handlePromptInput("hello")).not.toThrow();
  });
});