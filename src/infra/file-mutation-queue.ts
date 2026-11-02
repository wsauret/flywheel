import { resolve } from "node:path";
import { canonicalPathWithMissingTail } from "./canonical-path.js";

const fileMutationQueues = new Map<string, Promise<void>>();

/** Canonical physical identity shared by mutation queues and path reservations. */
export function canonicalMutationPath(filePath: string): string {
  try {
    return canonicalPathWithMissingTail(filePath);
  } catch {
    return resolve(filePath);
  }
}


/** Order the in-process mutations of one target, keyed by `filePath`'s
 *  canonical identity. */
export function withFileMutationQueue<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withMutationQueueKey(canonicalMutationPath(filePath), fn);
}

/** Order the in-process mutations of one target named by a logical key. A writer
 *  that holds its target directory open names the target it holds, whose identity
 *  must not change when a component of the path it was reached by is replaced, so
 *  the key is taken exactly as given. */
export async function withMutationQueueKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();
  let releaseNext!: () => void;
  const nextQueue = new Promise<void>((resolveQueue) => {
    releaseNext = resolveQueue;
  });
  const chainedQueue = currentQueue.then(() => nextQueue);
  fileMutationQueues.set(key, chainedQueue);

  await currentQueue;
  try {
    return await fn();
  } finally {
    releaseNext();
    if (fileMutationQueues.get(key) === chainedQueue) {
      fileMutationQueues.delete(key);
    }
  }
}

/** Settles after every in-process mutation of `filePath` queued so far. A reader
 *  waits here without joining the queue, so readers never wait on each other. */
export function queuedMutationsSettled(filePath: string): Promise<void> {
  return fileMutationQueues.get(canonicalMutationPath(filePath)) ?? Promise.resolve();
}

/** Acquire already-canonical mutation keys once, in deterministic deadlock-free order. */
export async function withMutationQueueKeys<T>(
  queueKeys: readonly string[],
  fn: () => Promise<T>,
  onAcquire?: (key: string) => void,
): Promise<T> {
  const keys = [...new Set(queueKeys)].sort();
  const run = (index: number): Promise<T> => {
    const key = keys[index];
    if (key === undefined) return fn();
    return withMutationQueueKey(key, () => {
      onAcquire?.(key);
      return run(index + 1);
    });
  };
  return run(0);
}

/**
 * Acquire the mutation queues for several paths before running `fn`. Keys are
 * deduplicated and acquired in sorted order so two concurrent multi-path
 * operations can never deadlock by nesting in opposite orders.
 */
export async function withFileMutationQueues<T>(
	filePaths: readonly string[],
	fn: () => Promise<T>,
): Promise<T> {
	return withMutationQueueKeys(filePaths.map(canonicalMutationPath), fn);
}
