/**
 * Session Viewport
 *
 * Manages switching the visible session in the TUI viewport.
 * Handles: loading session output from disk, swapping to live running
 * stores, LRU caching of visited session stores, and cancellation of
 * in-flight injection chains.
 *
 * Factory/DI pattern matching `createSessionOrchestrator(deps)`.
 *
 * Usage:
 *   const viewport = createSessionViewport({
 *     viewedSessionId, setViewedSessionId,
 *     activeStore, setActiveStore,
 *     subscribeToStore, setWorkState, setAppState,
 *     sessionControllers, sessionStores,
 *     orchestrator, toast,
 *   });
 *   viewport.openSession(sessionId);
 */

import { createStore } from "../routes/work/context/ui-state/store";
import { injectOutputBlocks, type InjectionHandle } from "./resume-utils";
import { snapshotToBlocks } from "../../schemas/output";
import type { UIActions } from "../routes/work/context/ui-state/types";
import type { AnyBlock } from "../routes/work/state/types";
import type { SessionOrchestrator } from "./session-orchestrator";
import type { AppState } from "./shell-modes";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal toast interface — only the show method we need. */
interface ToastSubset {
  show(opts: { message: string; variant: "info" | "error" | "warning" }): void;
}

/** Dependencies injected into the session viewport. */
export interface SessionViewportDeps {
  /** Current viewed session ID getter. */
  viewedSessionId: () => string | null;
  /** Set the viewed session ID signal. */
  setViewedSessionId: (id: string | null) => void;

  /** Current active store getter. */
  activeStore: () => UIActions | null;
  /** Set the active store signal. */
  setActiveStore: (store: UIActions | null) => void;

  /** Subscribe to store updates (sets workState via live subscription). */
  subscribeToStore: (store: UIActions) => void;
  /** Unsubscribe the current store subscription (if any). */
  unsubscribeStore: () => void;
  /** Set the work state signal directly. */
  setWorkState: (state: import("../routes/work/state/types").WorkState | null) => void;
  /** Set the app state signal (optional — shell may derive this instead). */
  setAppState?: (state: AppState) => void;

  /**
   * Map of sessionId → controller for running sessions.
   * A session has a controller iff it is currently executing.
   */
  sessionControllers: Map<string, { shutdown(): Promise<void> }>;
  /**
   * Map of sessionId → UIActions store for cached session stores.
   * LRU-capped at 5 entries (non-running sessions evicted first).
   */
  sessionStores: Map<string, UIActions>;

  /** Session orchestrator for loading session data from disk. */
  orchestrator: SessionOrchestrator;

  /** Toast for user feedback. */
  toast: ToastSubset;

  /** Set loading state during async disk reads (optional — for loading skeleton). */
  setSessionLoading?: (loading: boolean) => void;
}

/** The SessionViewport interface. */
export interface SessionViewport {
  /** Open a session in the viewport (switch visible session). */
  openSession(sessionId: string): Promise<void>;

  /** Cancel any in-flight injection and reset state. */
  cancelInjection(): void;
}

/** Max number of cached session stores (non-running). */
const LRU_CAP = 5;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new SessionViewport instance.
 *
 * @param deps - Injected dependencies (no direct module imports from shell).
 */
export function createSessionViewport(
  deps: SessionViewportDeps,
): SessionViewport {
  const {
    viewedSessionId,
    setViewedSessionId,
    setActiveStore,
    subscribeToStore,
    unsubscribeStore,
    setWorkState,
    sessionControllers,
    sessionStores,
    orchestrator,
    toast,
  } = deps;

  // Cancellation state for in-flight injection chains
  let _injectionHandle: InjectionHandle | null = null;
  let _currentLoadToken = 0;

  /**
   * Cancel any in-flight injection chain.
   */
  function cancelInjection(): void {
    if (_injectionHandle) {
      _injectionHandle.cancel();
      _injectionHandle = null;
    }
  }

  /**
   * Evict the oldest non-running entry from sessionStores if at cap.
   */
  function evictLRU(): void {
    if (sessionStores.size <= LRU_CAP) return;

    // Find the first non-running, non-viewed entry (oldest insertion order)
    const currentViewedId = viewedSessionId();
    for (const [id] of sessionStores) {
      // Never evict the currently viewed session or running sessions
      if (id === currentViewedId) continue;
      if (sessionControllers.has(id)) continue;
      sessionStores.delete(id);
      if (sessionStores.size <= LRU_CAP) return;
    }
  }

  /**
   * Open a session in the viewport.
   *
   * This does NOT resume execution or mutate session lifecycle state.
   * It merely switches the visible output to the target session.
   */
  async function openSession(sessionId: string): Promise<void> {
    // 1. No-op if already viewing this session
    if (viewedSessionId() === sessionId) return;

    // 2. Cancel any in-flight injection chain
    cancelInjection();

    // 3. Increment load token (stale detection)
    const myToken = ++_currentLoadToken;

    // Helper: hydrate store with subscription (running) or snapshot (non-running)
    const hydrateStore = (store: UIActions, isRunning: boolean) => {
      setActiveStore(store);
      if (isRunning) {
        subscribeToStore(store);
      } else {
        // Snapshot-only: unsubscribe any previous live subscription first
        unsubscribeStore();
        setWorkState(store.getState());
      }
    };

    // 4. Check if this is a running session — swap to its live store
    if (sessionControllers.has(sessionId)) {
      const store = sessionStores.get(sessionId);
      if (store) {
        hydrateStore(store, true);
        setViewedSessionId(sessionId);
        deps.setAppState?.("working");
        return;
      }
      // Controller exists but no store cached — fall through to disk load
    }

    // 5. Check LRU cache — reuse cached store
    if (sessionStores.has(sessionId)) {
      const cachedStore = sessionStores.get(sessionId)!;
      const isRunning = sessionControllers.has(sessionId);
      hydrateStore(cachedStore, isRunning);
      setViewedSessionId(sessionId);
      deps.setAppState?.(isRunning ? "working" : "completed");
      return;
    }

    // 6. Not cached — show loading state, then load from disk
    deps.setAppState?.("completed");
    setViewedSessionId(sessionId);
    deps.setSessionLoading?.(true);

    let result: Awaited<ReturnType<typeof orchestrator.handleResumeSession>>;
    try {
      result = await orchestrator.handleResumeSession(sessionId);
    } catch (err) {
      deps.setSessionLoading?.(false);
      toast.show({
        message: `Failed to load session: ${err instanceof Error ? err.message : String(err)}`,
        variant: "error",
      });
      return;
    }

    // 7. Stale check — another openSession was called while we awaited
    if (_currentLoadToken !== myToken) {
      deps.setSessionLoading?.(false);
      return;
    }

    if (!result) {
      toast.show({ message: "Session not found or corrupt", variant: "error" });
      return;
    }

    // 8. Create a fresh store for viewing (NOT createWorkflowSession — no timer/singleton reset)
    const store = createStore(result.planPath);

    // 9. Inject blocks with cancellation
    const blocks = snapshotToBlocks(result.outputBlocks) as AnyBlock[];
    _injectionHandle = injectOutputBlocks(store, blocks);

    // 10. Cache in LRU store map
    sessionStores.set(sessionId, store);
    evictLRU();

    // 11. Set as active store and hydrate view
    const isRunning = sessionControllers.has(sessionId);
    hydrateStore(store, isRunning);

    // 12. Determine app state: running → "working", else → "completed"
    deps.setAppState?.(isRunning ? "working" : "completed");
    deps.setSessionLoading?.(false);
  }

  return {
    openSession,
    cancelInjection,
  };
}
