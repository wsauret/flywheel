import { afterAll, afterEach } from "bun:test";
import { composeModuleServices } from "../../src/infra/module-service.js";
import { trackWorkerClose } from "../../src/infra/worker-termination.js";
import type { RuntimeTool } from "../../src/orchestration/agent-runtime/tools/types.js";
import { runGuest } from "../../src/orchestration/modules/code-mode/invocation-guest.js";
import type { GuestMessage, HostMessage } from "../../src/orchestration/modules/code-mode/invocation-protocol.js";
import type { InvocationWorker } from "../../src/orchestration/modules/code-mode/worker-pool.js";
import { createCodeModeRuntime, type CodeModeRuntime } from "../../src/orchestration/modules/code-mode/runtime.js";
import { createCodeModeService, type CodeModeService, type CodeModeServiceOptions } from "../../src/orchestration/modules/code-mode/service.js";

/** A Worker stand-in whose host side behaves like a Bun Worker: messages
 *  arrive as events, and `terminate()` dispatches `close`. It counts the
 *  host's listeners so a test can prove the bridge detached. Like a real
 *  guest, it confirms every reset unless a test turns `answersReset` off. */
export class FakeWorker extends EventTarget {
  readonly hostMessages: HostMessage[] = [];
  terminated = false;
  answersReset = true;
  readonly #listeners = new Map<string, number>();
  constructor(private readonly onMessage: (message: HostMessage) => void = () => {}) {
    super();
    // The production spawner tracks every Worker it creates, so a guest that
    // ends on its own is never terminated twice.
    trackWorkerClose(this);
  }
  /** The host listeners still attached for one event type. */
  listeners(type: string): number {
    return this.#listeners.get(type) ?? 0;
  }
  override addEventListener(...args: Parameters<EventTarget["addEventListener"]>): void {
    this.#listeners.set(args[0], this.listeners(args[0]) + 1);
    super.addEventListener(...args);
  }
  override removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>): void {
    this.#listeners.set(args[0], this.listeners(args[0]) - 1);
    super.removeEventListener(...args);
  }
  postMessage(message: HostMessage): void {
    this.hostMessages.push(message);
    if (message.type === "reset" && this.answersReset) this.send({ type: "ready", heapBytes: 0 });
    this.onMessage(message);
  }
  /** Delivers one guest message to the host on a later task, as a port does. */
  send(message: GuestMessage | object): void {
    setImmediate(() => { if (!this.terminated) this.dispatchEvent(new MessageEvent("message", { data: message })); });
  }
  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.dispatchEvent(new Event("close"));
  }
}

/** Runs the real guest on the test's own thread behind a real message
 *  channel, so every message crosses structured clone as it does between
 *  threads. `guestMessages` records what the guest posted, in order. */
export class InProcessInvocationWorker extends FakeWorker {
  readonly guestMessages: GuestMessage[] = [];
  readonly #host: MessagePort;
  readonly #guest: MessagePort;
  readonly #stop: () => void;
  readonly #posted = new Map<GuestMessage["type"], PromiseWithResolvers<void>>();

  constructor() {
    super();
    const channel = new MessageChannel();
    this.#host = channel.port1;
    this.#guest = channel.port2;
    this.#host.addEventListener("message", (event) => {
      const message: GuestMessage = event.data;
      this.guestMessages.push(message);
      this.#posted.get(message.type)?.resolve();
      this.dispatchEvent(new MessageEvent("message", { data: message }));
    });
    this.#host.start();
    this.#guest.start();
    this.#stop = runGuest(this.#guest);
  }

  /** Settles once the host has received a guest message of this type. */
  posted(type: GuestMessage["type"]): Promise<void> {
    if (this.guestMessages.some((message) => message.type === type)) return Promise.resolve();
    const waiting = this.#posted.get(type) ?? Promise.withResolvers<void>();
    this.#posted.set(type, waiting);
    return waiting.promise;
  }

  override postMessage(message: HostMessage): void {
    this.hostMessages.push(message);
    this.#host.postMessage(message);
  }

  override terminate(): void {
    if (this.terminated) return;
    this.#stop();
    this.#host.close();
    this.#guest.close();
    super.terminate();
  }
}

/** A guest the test scripts by hand: it answers nothing on its own. */
export function scriptedWorker(onMessage?: (message: HostMessage, worker: FakeWorker) => void): FakeWorker {
  const worker: FakeWorker = new FakeWorker((message) => onMessage?.(message, worker));
  return worker;
}

/** Records every Worker a service opens. */
export function workerLog<W extends InvocationWorker>(open: () => W) {
  const opened: W[] = [];
  return {
    opened,
    openWorker: (): W => {
      const worker = open();
      opened.push(worker);
      return worker;
    },
  };
}

/** Code Mode services whose invocations run the real guest in process,
 *  unless a test opens its own Workers. The calling file owns every service it
 *  makes, and each is disposed after its case. Call it at the top level of the
 *  file, never inside a test, because it registers hooks in that scope.
 *
 *  A service keeps its idle Workers until it is disposed, and each Worker
 *  holds a message port open. On Windows an open port that one file leaves
 *  makes every later bridge test in the same test process wait about a second
 *  between cases. */
export function codeModeServices(): (options?: CodeModeServiceOptions) => CodeModeService {
  const created: CodeModeService[] = [];
  const disposeCreated = (): Promise<unknown> => Promise.all(created.splice(0).map((service) => service.dispose()));
  afterEach(disposeCreated);
  afterAll(disposeCreated);
  return (options = {}) => {
    const service = createCodeModeService({ ...options, openWorker: options.openWorker ?? (() => new InProcessInvocationWorker()) });
    created.push(service);
    return service;
  };
}

/** The module's real per-runner runtime over one service. A runtime that
 *  runs no invocation can take the default service, which opens no Worker. */
export function codeModeRuntimeOver(service: CodeModeService = createCodeModeService({ openWorker: () => new InProcessInvocationWorker() })): CodeModeRuntime {
  const runtime = createCodeModeRuntime({ modules: composeModuleServices([["code-mode", service]]) });
  if (!runtime) throw new Error("the Code Mode runtime builds whenever its service is present");
  return runtime;
}

/** The `code` tool one request would plan over `eligible`, for a tree whose capture holds code-only tools and bash
 *  unless `surface` says otherwise. */
export function codeToolOver(eligible: ReadonlyMap<string, RuntimeTool>, service?: CodeModeService, surface: Parameters<CodeModeRuntime["createTool"]>[0] = { nestedTools: true, bash: true }): RuntimeTool {
  return codeModeRuntimeOver(service).createTool(surface)(eligible, new Set()).tool;
}
