/**
 * Explicit owner of one host's background execution.
 *
 * Background work can outlive the turn that started it. Host-owned work, such
 * as a subagent or background command, closes with the runner. A workflow has
 * its own durable session, so the host tracks its result but detaches that
 * observer on close. The owner carries the Effect scope, blanket kill signal,
 * and registry that enforce these distinct lifetimes.
 *
 * `close()` is the host's settlement gate. It runs one fixed order and is
 * idempotent, so a host that closes on both its failure and its success path
 * closes once and every caller awaits the same settlement:
 *
 *  1. stop admission, so nothing new is admitted or registered from here on;
 *  2. fire the kill signal and close the owned scope, which interrupts every
 *     admitted dispatch fiber and awaits its real settlement - including a
 *     dispatch still queued behind the concurrency admission gate (ARCH-TOOLS-004), which is why
 *     the registry is only touched afterwards;
 *  3. when the host closes for a planned replacement, hand every running
 *     managed command to the next build, so the next step ends none of them.
 *     A host closes for the replacement when the replacement's pause marked
 *     it through `handOverAtClose()`, or when it closes during its executor's
 *     stop for a heard handoff. Every other close, such as a person deleting
 *     a chat or a child that settles, ends its commands;
 *  4. terminate every tracked task and await it, so each one's notification is
 *     delivered or suppressed before close resolves; and
 *  5. drain each registered settle, in registration order.
 *
 * A host built with a command handover adopts the commands a previous build
 * handed to its conversation through `adoptHandedOver()`, before its first
 * model request, so a re-entered host parks on an adopted command as on one it
 * launched, taking each row's command from its executor's keeper when the
 * keeper holds it. A row that pass leaves, such as one whose supervisor did
 * not answer in time, is tried again in the background, at a growing
 * interval, until none is left or the host closes. The executor's keeper is
 * one such owner per conversation no host holds, which gives each command it
 * holds up to that conversation's host through `release()`.
 *
 * A host closes its owner before it disposes anything the background work can
 * still reach: durable writers, conversation trees and projections, render
 * callbacks, injection queues.
 */

import { Effect, Exit, Fiber, Scope } from "effect";
import { errorMessage } from "../../infra/error-message.js";
import { Log } from "../../infra/log.js";
import type { OwnedProcess } from "../../infra/owned-subprocess.js";
import type { BackgroundWorkRegistry } from "./background-work.js";
import type { CommandHandoverHost } from "./command-handover.js";
import { createShellRuntime } from "./tools/shell-runtime.js";
import type { ShellRuntimeClient } from "./tools/shell-runtime-types.js";

const log = Log.create({ service: "background-execution-owner" });

/** The wait before a row an adoption left is tried again, which doubles up
 *  to the longest. A row stays left while its supervisor cannot answer, or
 *  speaks another version, so the longest wait bounds how late this host
 *  learns that such a command ended. */
const ADOPTION_RETRY_FIRST_MS = 1_000;
const ADOPTION_RETRY_LONGEST_MS = 30_000;

export interface BackgroundExecutionOwner<R extends BackgroundWorkRegistry = BackgroundWorkRegistry> {
  /** Fires once, at the start of `close()`. Background dispatches ride it so
   *  work still being constructed when the host closes is stopped too. */
  readonly signal: AbortSignal;
  readonly tasks: R;
  /** Host-generation shell execution surface. */
  readonly shell: ShellRuntimeClient;
  /** Admits one background dispatch and forks it into this owner's scope, so the
   *  owner's close interrupts it and awaits its exit: a `close()` that lands
   *  while the dispatch is still queued behind the admission gate waits for it
   *  instead of racing it. `work` receives this owner's kill signal, and it must
   *  own whatever external Promise it starts, which is what
   *  `bridgeExternalPromise` is for: the fiber's exit is all this owner can
   *  await. Null once closed, so refused work never starts and never falls into
   *  a detached lifetime. */
  run<A, E = never>(work: (signal: AbortSignal) => Effect.Effect<A, E>): Fiber.Fiber<A, E> | null;
  /** Registers owned work `close()` must drain after the registry. Throws once
   *  closed: nothing registered then would ever be drained. */
  addSettle(settle: () => Promise<void>): void;
  /** Marks the close as a planned replacement's, before the replacement's
   *  pause ends the host's work ahead of its executor's stop: the close then
   *  hands every running command to the next build instead of ending it. */
  handOverAtClose(): void;
  /** Adopts the commands a previous build handed to this host's conversation,
   *  once, and tries each row it left again until the host closes. Resolves
   *  after the first pass, at once for a host built without a command
   *  handover, and never rejects. */
  adoptHandedOver(): Promise<void>;
  /** Gives the running command `processId` to another host in this process,
   *  once an adoption pass under way has finished, and answers its
   *  container. Nothing when this owner holds no such command or has begun
   *  to close. */
  release(processId: string): Promise<OwnedProcess | undefined>;
  close(): Promise<void>;
}

export function createBackgroundExecutionOwner<R extends BackgroundWorkRegistry>(
  tasks: R,
  handover?: CommandHandoverHost,
  options: {
    /** A chat's own turns run this host's commands (agent purpose
     *  `interactive-chat`), so processor admission never holds them. */
    readonly processorExempt?: boolean;
    /** The first wait before a left row is tried again; a test shortens it. */
    readonly adoptionRetryFirstMs?: number;
  } = {},
): BackgroundExecutionOwner<R> {
  const adoptionRetryFirstMs = options.adoptionRetryFirstMs ?? ADOPTION_RETRY_FIRST_MS;
  const abort = new AbortController();
  const shellRuntime = createShellRuntime(tasks, { signal: abort.signal, processorExempt: options.processorExempt === true });
  const dispatches = Scope.makeUnsafe("parallel");
  const settles: Array<() => Promise<void>> = [tasks.closeNotifications];
  let closing: Promise<void> | null = null;
  let firstAdoption: Promise<void> | undefined;
  let adoption: Promise<number> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let markedForReplacement = false;

  /** One adoption pass, which answers how many rows it left. */
  const adopt = (host: CommandHandoverHost, quiet: boolean): Promise<number> => {
    adoption = shellRuntime.adopt(host, quiet).catch((err: unknown) => {
      log.warn("handed-over commands could not be read; they are left for a later host", { sessionId: host.sessionId, error: errorMessage(err) });
      return 0;
    });
    return adoption;
  };
  const retryAdoption = (host: CommandHandoverHost, delayMs: number): void => {
    if (closing) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void adopt(host, true).then((left) => { if (left > 0) retryAdoption(host, Math.min(delayMs * 2, ADOPTION_RETRY_LONGEST_MS)); });
    }, delayMs);
    retryTimer.unref?.();
  };

  const drain = async (): Promise<void> => {
    // An adoption still registering commands finishes first, so this close
    // hands over or ends what it adopted instead of racing it. Without one,
    // admission stops within the call to close().
    clearTimeout(retryTimer);
    if (adoption) await adoption;
    tasks.stopAdmission();
    abort.abort();
    // Decided and started before any await: the handover reads the running
    // commands now, while each one that has not settled has also not
    // published.
    const handingOver = handover !== undefined && (markedForReplacement || handover.authority.stopping()) ? shellRuntime.handOver(handover) : undefined;
    // Every admitted dispatch is a fiber in this scope, so closing it awaits
    // each one's real settlement. Only then is the registry snapshot stable:
    // a dispatch that registers its task on its way out has already done so.
    await Effect.runPromise(Scope.close(dispatches, Exit.void));
    await handingOver;
    await tasks.terminateAll();
    await shellRuntime.close();
    for (const settle of settles) {
      try {
        await settle();
      } catch (err) {
        // A settle reports settlement, so a rejection means the work it owns
        // already failed. The host still needs the remaining settles drained.
        log.warn("background settle failed during close", { error: errorMessage(err) });
      }
    }
  };

  return {
    signal: abort.signal,
    tasks,
    shell: shellRuntime.client,
    run(work) {
      if (closing) return null;
      return Effect.runSync(Effect.forkIn(work(abort.signal), dispatches));
    },
    addSettle(settle) {
      if (closing) throw new Error("background execution owner is closed; nothing can be registered after close()");
      settles.push(settle);
    },
    handOverAtClose() {
      markedForReplacement = true;
    },
    adoptHandedOver() {
      if (handover === undefined || closing) return firstAdoption ?? Promise.resolve();
      firstAdoption ??= adopt(handover, false).then((left) => { if (left > 0) retryAdoption(handover, adoptionRetryFirstMs); });
      return firstAdoption;
    },
    async release(processId) {
      await adoption;
      if (closing || tasks.processRecord(processId)?.status !== "running") return undefined;
      return tasks.processCommand(processId)?.release();
    },
    close() {
      closing ??= drain();
      return closing;
    },
  };
}
