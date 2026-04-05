import { describe, it, expect, mock, beforeEach } from "bun:test";
import {
  createChatController,
  type ChatControllerDeps,
  type ChatController,
  type ToastLike,
} from "../src/tui/shell/chat-controller";
import type { AppState } from "../src/tui/shell/shell-modes";
import type { UIActions } from "../src/tui/routes/work/context/ui-state/types";
import type { WorkState } from "../src/tui/types";
import type { ModelActivity } from "../src/tui/adapters/structured-output-builder";

/**
 * Chat Controller Tests
 *
 * Verifies the chat controller factory and its lifecycle management:
 *   - startChat() creates a chat session and transitions to 'chatting' state
 *   - startChat() returns false when API key is missing (graceful fallback)
 *   - sendMessage() routes to the active chat session
 *   - destroyChat() captures conversation summary and destroys the session
 *   - restartChat() tears down and creates a fresh session
 *   - getConversationSummary() returns empty string when no session
 *   - dispose() cleans up resources
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDeps(overrides: Partial<ChatControllerDeps> = {}): ChatControllerDeps {
  const toastShow = mock(() => {});
  const toast: ToastLike = { show: toastShow as ToastLike["show"] };

  return {
    setAppState: mock((state: AppState) => {}),
    setActiveStore: mock((store: UIActions | null) => {}),
    setWorkState: mock((state: WorkState | null) => {}),
    subscribeToStore: mock((store: UIActions) => {}),
    unsubscribeStore: mock(() => {}),
    setModelActivity: mock((activity: ModelActivity) => {}),
    toast,
    getProjectCwd: () => "/tmp/test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createChatController", () => {
  it("exports createChatController function", () => {
    expect(typeof createChatController).toBe("function");
  });

  it("returns an object with the ChatController interface", () => {
    const deps = createMockDeps();
    const controller = createChatController(deps);

    expect(typeof controller.startChat).toBe("function");
    expect(typeof controller.sendMessage).toBe("function");
    expect(typeof controller.destroyChat).toBe("function");
    expect(typeof controller.restartChat).toBe("function");
    expect(typeof controller.getConversationSummary).toBe("function");
    expect(typeof controller.isActive).toBe("function");
    expect(typeof controller.dispose).toBe("function");
  });
});

describe("startChat", () => {
  it("returns false when ANTHROPIC_API_KEY is missing", () => {
    const original = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];

    try {
      const deps = createMockDeps();
      const controller = createChatController(deps);
      const started = controller.startChat();

      expect(started).toBe(false);
      expect(controller.isActive()).toBe(false);
      expect((deps.toast as any).show).toHaveBeenCalledTimes(1);
    } finally {
      if (original !== undefined) {
        process.env["ANTHROPIC_API_KEY"] = original;
      }
    }
  });

  it("returns true and transitions to chatting state when API key is present", () => {
    const original = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "test-key-not-real";

    try {
      const deps = createMockDeps();
      const controller = createChatController(deps);
      const started = controller.startChat();

      expect(started).toBe(true);
      expect(controller.isActive()).toBe(true);
      expect(deps.setAppState).toHaveBeenCalledWith("chatting");
      expect(deps.setActiveStore).toHaveBeenCalled();
      expect(deps.subscribeToStore).toHaveBeenCalled();
      expect(deps.setModelActivity).toHaveBeenCalledWith("idle");

      controller.dispose();
    } finally {
      if (original !== undefined) {
        process.env["ANTHROPIC_API_KEY"] = original;
      } else {
        delete process.env["ANTHROPIC_API_KEY"];
      }
    }
  });
});

describe("isActive", () => {
  it("returns false initially", () => {
    const deps = createMockDeps();
    const controller = createChatController(deps);
    expect(controller.isActive()).toBe(false);
  });
});

describe("getConversationSummary", () => {
  it("returns empty string when no session is active", () => {
    const deps = createMockDeps();
    const controller = createChatController(deps);
    expect(controller.getConversationSummary()).toBe("");
  });
});

describe("destroyChat", () => {
  it("returns empty string when no session is active", async () => {
    const deps = createMockDeps();
    const controller = createChatController(deps);
    const summary = await controller.destroyChat();
    expect(summary).toBe("");
  });

  it("destroys session and returns conversation summary", async () => {
    const original = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "test-key-not-real";

    try {
      const deps = createMockDeps();
      const controller = createChatController(deps);
      controller.startChat();

      expect(controller.isActive()).toBe(true);

      const summary = await controller.destroyChat();

      // Summary should be a string (may be 'No messages sent.' since we didn't send any)
      expect(typeof summary).toBe("string");
      expect(controller.isActive()).toBe(false);
      expect(deps.unsubscribeStore).toHaveBeenCalled();
      expect(deps.setActiveStore).toHaveBeenCalledWith(null);
      expect(deps.setWorkState).toHaveBeenCalledWith(null);
    } finally {
      if (original !== undefined) {
        process.env["ANTHROPIC_API_KEY"] = original;
      } else {
        delete process.env["ANTHROPIC_API_KEY"];
      }
    }
  });
});

describe("restartChat", () => {
  it("tears down and creates a fresh session", () => {
    const original = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "test-key-not-real";

    try {
      const deps = createMockDeps();
      const controller = createChatController(deps);

      // Start initial chat
      controller.startChat();
      expect(controller.isActive()).toBe(true);

      // Restart
      const restarted = controller.restartChat();
      expect(restarted).toBe(true);
      expect(controller.isActive()).toBe(true);

      // setAppState should have been called with 'chatting' twice (once per start)
      const calls = (deps.setAppState as ReturnType<typeof mock>).mock.calls;
      const chattingCalls = calls.filter((c: unknown[]) => c[0] === "chatting");
      expect(chattingCalls.length).toBe(2);

      controller.dispose();
    } finally {
      if (original !== undefined) {
        process.env["ANTHROPIC_API_KEY"] = original;
      } else {
        delete process.env["ANTHROPIC_API_KEY"];
      }
    }
  });

  it("returns false when API key is missing on restart", () => {
    const original = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "test-key-not-real";

    try {
      const deps = createMockDeps();
      const controller = createChatController(deps);
      controller.startChat();
      expect(controller.isActive()).toBe(true);

      // Remove API key before restart
      delete process.env["ANTHROPIC_API_KEY"];
      const restarted = controller.restartChat();

      expect(restarted).toBe(false);
      expect(controller.isActive()).toBe(false);

      controller.dispose();
    } finally {
      if (original !== undefined) {
        process.env["ANTHROPIC_API_KEY"] = original;
      }
    }
  });
});

describe("dispose", () => {
  it("is safe to call when no session is active", () => {
    const deps = createMockDeps();
    const controller = createChatController(deps);
    expect(() => controller.dispose()).not.toThrow();
  });

  it("cleans up active session", () => {
    const original = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "test-key-not-real";

    try {
      const deps = createMockDeps();
      const controller = createChatController(deps);
      controller.startChat();
      expect(controller.isActive()).toBe(true);

      controller.dispose();
      expect(controller.isActive()).toBe(false);
    } finally {
      if (original !== undefined) {
        process.env["ANTHROPIC_API_KEY"] = original;
      } else {
        delete process.env["ANTHROPIC_API_KEY"];
      }
    }
  });
});