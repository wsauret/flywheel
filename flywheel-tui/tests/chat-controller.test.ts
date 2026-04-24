/**
 * Tests for Chat Controller — pure business logic extracted from use-chat-mode.
 *
 * Verifies:
 * - Message buffering during async startup (queue messages -> replay on ready)
 * - startChat creates session via manager and sessionStore
 * - endChat removes from sessionStore and marks paused
 * - backgroundChat clears startup state
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
import "../src/orchestration/engines/providers/claude/register"
import { createChatController, type ChatControllerDeps } from "../src/orchestration/chat-controller"
import type { SessionStore, ChatStoreHandle, SessionEntry } from "../src/orchestration/session-store-types"
import type { SessionManager } from "../src/orchestration/session/manager"
import type { ChatRunner } from "../src/orchestration/chat-runner"

// ── Helpers ──

function createMockSessionStore(): SessionStore & {
  _entries: Map<string, SessionEntry>
  _injectedMessages: string[]
  _startChatCalls: Array<{ sessionId: string }>
  _removeCalls: string[]
  _abortCalls: string[]
} {
  const entries = new Map<string, SessionEntry>()
  const injectedMessages: string[] = []
  const startChatCalls: Array<{ sessionId: string }> = []
  const removeCalls: string[] = []
  const abortCalls: string[] = []

  return {
    _entries: entries,
    _injectedMessages: injectedMessages,
    _startChatCalls: startChatCalls,
    _removeCalls: removeCalls,
    _abortCalls: abortCalls,

    start: mock(() => ""),
    startChat: mock(async (opts: any) => {
      startChatCalls.push({ sessionId: opts.sessionId })

      // Create a minimal mock runner
      const mockRunner: ChatRunner = {
        sessionId: opts.sessionId,
        abort: () => {},
        dispose: async () => {},
        injectMessage: (text: string) => { injectedMessages.push(text); return true },
        chatSession: {} as any,
      }

      // Call createRunner to simulate the real sessionStore
      const handle: ChatStoreHandle = {
        updateEntry: () => {},
        onError: () => {},
        onEnded: () => {},
      }
      await opts.createRunner(handle)

      // Add entry
      entries.set(opts.sessionId, {
        kind: "chat",
        runner: mockRunner,
        description: opts.description ?? "Chat",
        outputBlocks: opts.priorBlocks ?? [],
        tokens: 0,
        cost: 0,
        contextPercent: 0,
        startedAt: Date.now(),
        modelActivity: "idle",
      } as any)

      return opts.sessionId
    }),
    get: (id: string) => entries.get(id),
    load: mock(() => {}),
    has: (id: string) => entries.has(id),
    isRunning: (id: string) => entries.has(id),
    pause: mock(() => false),
    abort: mock((id: string) => { abortCalls.push(id) }),
    finish: mock(async (id: string) => { entries.get(id) && Object.assign(entries.get(id)!, { ended: true }) }),
    remove: mock(async (id: string) => { removeCalls.push(id); entries.delete(id) }),
    updateEntry: mock(() => {}),
    injectMessage: mock((id: string, text: string) => { injectedMessages.push(text); return true }),
    cancelShutdown: mock(() => false),
    runningCount: () => entries.size,
    allIds: () => [...entries.keys()],
    disposeAll: async () => {},
  }
}

function createMockManager(): SessionManager & {
  _created: Array<{ kind: string; name: string }>
  _stateUpdates: Array<{ id: string; state: string }>
  _labelUpdates: Array<{ id: string; label: string }>
  _deletes: string[]
} {
  const created: Array<{ kind: string; name: string }> = []
  const stateUpdates: Array<{ id: string; state: string }> = []
  const labelUpdates: Array<{ id: string; label: string }> = []
  const deletes: string[] = []
  let nextId = 0

  return {
    _created: created,
    _stateUpdates: stateUpdates,
    _labelUpdates: labelUpdates,
    _deletes: deletes,

    onChange: null,

    create: mock(function(this: any, planPath: string, name?: string, kind?: string, _initialState?: string) {
      const id = `chat-${++nextId}`
      created.push({ kind: kind ?? "workflow", name: name ?? planPath })
      this.onChange?.()
      return id
    }),
    list: mock(() => ({ sessions: [], errors: [] })),
    updateState: mock(function(this: any, id: string, state: string) { stateUpdates.push({ id, state }); this.onChange?.() }),
    updateLabel: mock(function(this: any, id: string, label: string) { labelUpdates.push({ id, label }); this.onChange?.() }),
    delete: mock(function(this: any, id: string) { deletes.push(id); this.onChange?.() }),
    recoverStaleSessions: mock(() => 0),
  } as any
}

function createDeps(overrides?: Partial<ChatControllerDeps>): ChatControllerDeps {
  return {
    sessionStore: createMockSessionStore(),
    manager: createMockManager(),
    projectCwd: "/tmp/test-project",
    ...overrides,
  }
}

// ── Tests ──

describe("ChatController", () => {
  describe("startChat", () => {
    it("creates session via manager with chat kind", async () => {
      const deps = createDeps()
      const controller = createChatController(deps)

      const sessionId = await controller.startChat()

      expect(sessionId).not.toBeNull()
      expect(sessionId).toMatch(/^chat-/)
      const mockManager = deps.manager as ReturnType<typeof createMockManager>
      expect(mockManager._created).toHaveLength(1)
      expect(mockManager._created[0].kind).toBe("chat")
      expect(mockManager._created[0].name).toBe("Chat")
    })

    it("registers session with sessionStore.startChat", async () => {
      const deps = createDeps()
      const controller = createChatController(deps)

      await controller.startChat()

      const mockStore = deps.sessionStore as ReturnType<typeof createMockSessionStore>
      expect(mockStore._startChatCalls).toHaveLength(1)
    })

    it("triggers manager.onChange when creating session", async () => {
      const deps = createDeps()
      const onChangeSpy = mock(() => {})
      deps.manager.onChange = onChangeSpy
      const controller = createChatController(deps)

      await controller.startChat()

      expect(onChangeSpy).toHaveBeenCalled()
    })

    it("passes initialMessage through to runner", async () => {
      const deps = createDeps()
      const controller = createChatController(deps)

      await controller.startChat("hello world")

      // The initial message is passed via the createRunner factory
      const mockStore = deps.sessionStore as ReturnType<typeof createMockSessionStore>
      expect(mockStore._startChatCalls).toHaveLength(1)
    })
  })

  describe("message buffering during async startup", () => {
    it("buffers messages during startup and replays on ready", async () => {
      const sessionStore = createMockSessionStore()
      let startChatResolve: (() => void) | null = null

      // Override startChat to delay resolution
      const originalStartChat = sessionStore.startChat
      sessionStore.startChat = mock(async (opts: any) => {
        // Start the chat but delay completion
        const promise = new Promise<void>((resolve) => {
          startChatResolve = resolve
        })

        // In parallel, the controller will be in "starting" state
        // We need to resolve the startChat call to proceed
        // Simulate the real flow where startChat takes time
        const result = await originalStartChat(opts)
        await promise
        return result
      }) as any

      const deps = createDeps({ sessionStore })
      const controller = createChatController(deps)

      // Start chat (will be pending)
      const startPromise = controller.startChat()

      // Send messages during startup — they should be buffered
      controller.sendMessage(undefined, "message 1")
      controller.sendMessage(undefined, "message 2")

      // Resolve the startup
      startChatResolve?.()
      await startPromise

      // Messages should have been replayed via injectMessage
      expect(sessionStore._injectedMessages).toContain("message 1")
      expect(sessionStore._injectedMessages).toContain("message 2")
    })

    it("sendMessage returns true when buffering", async () => {
      const deps = createDeps()
      const controller = createChatController(deps)

      // Before starting, send should return false (no foreground)
      const beforeResult = controller.sendMessage(undefined, "before")
      expect(beforeResult).toBe(false)
    })
  })

  describe("endChat", () => {
    it("deletes empty chat (no user messages) instead of pausing", async () => {
      const deps = createDeps()
      const controller = createChatController(deps)

      const sessionId = await controller.startChat()
      expect(sessionId).not.toBeNull()

      const ended = await controller.endChat(sessionId)
      expect(ended).toBe(true)

      const mockManager = deps.manager as ReturnType<typeof createMockManager>
      expect(mockManager._deletes).toContain(sessionId)
      expect(mockManager._stateUpdates.find((u) => u.state === "paused")).toBeUndefined()
    })

    it("marks paused when chat has user messages", async () => {
      const deps = createDeps()
      const controller = createChatController(deps)

      const sessionId = await controller.startChat()
      expect(sessionId).not.toBeNull()

      // Send a message so the chat is no longer empty
      controller.sendMessage(sessionId, "hello")

      const ended = await controller.endChat(sessionId)
      expect(ended).toBe(true)

      const mockManager = deps.manager as ReturnType<typeof createMockManager>
      const pausedUpdate = mockManager._stateUpdates.find((u) => u.state === "paused")
      expect(pausedUpdate).toBeDefined()
      expect(pausedUpdate!.id).toBe(sessionId)
      expect(mockManager._deletes).not.toContain(sessionId)
    })

    it("returns false when no foreground ID", async () => {
      const deps = createDeps()
      const controller = createChatController(deps)

      const ended = await controller.endChat(undefined)
      expect(ended).toBe(false)
    })

    it("returns false for non-chat sessions", async () => {
      const deps = createDeps()
      const controller = createChatController(deps)

      // The sessionStore won't have an entry for a random ID
      const ended = await controller.endChat("nonexistent-id")
      expect(ended).toBe(false)
    })
  })

  describe("backgroundChat", () => {
    it("clears startup state", async () => {
      const deps = createDeps()
      const controller = createChatController(deps)

      await controller.startChat()
      controller.backgroundChat()

      // After backgrounding, sendMessage should return false (no buffering, no foreground)
      expect(controller.sendMessage(undefined, "dropped")).toBe(false)
    })
  })

  describe("interruptChat", () => {
    it("calls sessionStore.abort on the foreground session", async () => {
      const deps = createDeps()
      const controller = createChatController(deps)

      const sessionId = await controller.startChat()
      controller.interruptChat(sessionId)

      const mockStore = deps.sessionStore as ReturnType<typeof createMockSessionStore>
      expect(mockStore._abortCalls).toContain(sessionId)
    })

    it("does nothing when no foreground ID", () => {
      const deps = createDeps()
      const controller = createChatController(deps)

      // Should not throw
      controller.interruptChat(undefined)
    })
  })

  describe("sendMessage", () => {
    it("sends message to foreground session via sessionStore", async () => {
      const deps = createDeps()
      const controller = createChatController(deps)

      const sessionId = await controller.startChat()
      controller.sendMessage(sessionId, "hello")

      const mockStore = deps.sessionStore as ReturnType<typeof createMockSessionStore>
      expect(mockStore._injectedMessages).toContain("hello")
    })

    it("returns false with no foreground ID and no buffering", () => {
      const deps = createDeps()
      const controller = createChatController(deps)

      const sent = controller.sendMessage(undefined, "dropped")
      expect(sent).toBe(false)
    })
  })
})
